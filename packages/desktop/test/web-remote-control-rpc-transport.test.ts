import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WebRemoteControlRpcTransport,
  crc32Hex,
  type RpcPayload,
} from "../src/main/webRemoteControlRpcTransport.ts";

const identity = {
  bridgeSessionId: "bridge-1",
  bridgeGeneration: 2,
  recoveryId: "recovery-1",
};

function connect(maxFrameBytes = 256) {
  const leftInbound: RpcPayload[] = [];
  const rightInbound: RpcPayload[] = [];
  const leftMessages: Uint8Array[] = [];
  const rightMessages: Uint8Array[] = [];
  const leftFaults: unknown[] = [];
  const rightFaults: unknown[] = [];
  let left!: WebRemoteControlRpcTransport;
  let right!: WebRemoteControlRpcTransport;
  left = new WebRemoteControlRpcTransport({
    ...identity,
    maxFrameBytes,
    sendFrame: (frame) => {
      rightInbound.push(frame);
      right.acceptPayload(frame);
    },
    onMessage: (message) => leftMessages.push(message),
    onFault: (fault) => leftFaults.push(fault),
  });
  right = new WebRemoteControlRpcTransport({
    ...identity,
    maxFrameBytes,
    sendFrame: (frame) => {
      leftInbound.push(frame);
      left.acceptPayload(frame);
    },
    onMessage: (message) => rightMessages.push(message),
    onFault: (fault) => rightFaults.push(fault),
  });
  return {
    left,
    right,
    leftInbound,
    rightInbound,
    leftMessages,
    rightMessages,
    leftFaults,
    rightFaults,
  };
}

test("roundtrips fragmented Uint8Array messages and emits cumulative ACK", () => {
  const maxFrameBytes = 320;
  const link = connect(maxFrameBytes);
  const message = new Uint8Array(900).map((_, index) => index % 251);
  link.left.send(message);
  assert.deepEqual(link.rightMessages, [message]);
  assert.equal(link.leftInbound.at(-1)?.zcode_type, "rpc-frame-ack");
  assert.equal(link.leftInbound.at(-1)?.ackMessageSeq, 1);
  assert.ok(link.rightInbound.filter((frame) => frame.zcode_type === "rpc-frame").length > 1);
  for (const frame of link.rightInbound) {
    if (frame.zcode_type === "rpc-frame") {
      assert.ok(new TextEncoder().encode(JSON.stringify(frame)).byteLength <= maxFrameBytes);
    }
  }
});

test("replays unacknowledged frames and retires them after ACK", () => {
  const sent: RpcPayload[] = [];
  const transport = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => sent.push(frame),
    onMessage: () => undefined,
  });
  transport.send(new Uint8Array([1, 2, 3]));
  const firstSendCount = sent.length;
  assert.equal(firstSendCount, 1);
  assert.equal(transport.replayUnacknowledged(), true);
  assert.equal(sent.length, firstSendCount * 2);
  assert.equal(
    transport.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...identity,
      ackMessageSeq: 1,
    }),
    true,
  );
  assert.equal(transport.replayUnacknowledged(), true);
  assert.equal(sent.length, firstSendCount * 2);
});

test("rejects identity mismatch, invalid CRC, and physical gaps", () => {
  const faults: Array<{ reason: string }> = [];
  const frames: RpcPayload[] = [];
  const transport = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => frames.push(frame),
    onMessage: () => undefined,
    onFault: (fault) => faults.push(fault),
  });
  assert.equal(
    transport.acceptPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "other",
      ackMessageSeq: 1,
    }),
    false,
  );
  transport.send(new Uint8Array([9, 8, 7]));
  const frame = frames[0];
  assert.equal(frame.zcode_type, "rpc-frame");
  assert.equal(transport.acceptPayload({ ...frame, seq: frame.seq + 1 }), false);
  assert.equal(
    transport.acceptPayload({ ...frame, checksum: { algorithm: "crc32", value: "00000000" } }),
    false,
  );
  assert.deepEqual(
    faults.map((fault) => fault.reason),
    ["identityMismatch", "physicalGap", "checksumMismatch"],
  );
  assert.equal(crc32Hex(new Uint8Array([9, 8, 7])), frame.checksum.value);
});

test("accepts exact duplicates once and rejects conflicting duplicates", () => {
  const received: Uint8Array[] = [];
  const faults: Array<{ reason: string }> = [];
  const emitted: RpcPayload[] = [];
  const sender = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: (frame) => emitted.push(frame),
    onMessage: () => undefined,
  });
  const receiver = new WebRemoteControlRpcTransport({
    ...identity,
    sendFrame: () => undefined,
    onMessage: (message) => received.push(message),
    onFault: (fault) => faults.push(fault),
  });
  sender.send(new Uint8Array([4, 5, 6]));
  const frame = emitted[0];
  assert.equal(receiver.acceptPayload(frame), true);
  assert.equal(receiver.acceptPayload(frame), true);
  assert.equal(received.length, 1);
  assert.equal(receiver.acceptPayload({ ...frame, dataBase64: "BAUA" }), false);
  assert.equal(faults.at(-1)?.reason, "conflictingDuplicate");
});
