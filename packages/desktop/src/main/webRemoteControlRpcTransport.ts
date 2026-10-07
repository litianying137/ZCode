/**
 * Ordered, acknowledged relay transport for the binary RPC bridge.
 *
 * The relay carries JSON payloads. This module owns the wire envelope and
 * exposes only Uint8Array messages to its caller.
 */

export const SHARED_MAX_FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 64;
// 未 ACK 消息的重发保留上限。超出后丢弃最老批次（只影响断线重放，不影响
// 在线投递）。此前无上限：手机停止 ACK（关页面/弱网）时 outbound 无限滞留，
// 主进程堆被 base64/JSON 帧字符串撑爆（2026-10-07 两次 V8 4GB OOM crash）。
const DEFAULT_MAX_RETAINED_BYTES = 64 * 1024 * 1024;

export interface RpcIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export interface RpcFrame {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  dataBase64: string;
}

export interface RpcFrameAck extends RpcIdentity {
  zcode_type: "rpc-frame-ack";
  ackMessageSeq: number;
}

export type RpcPayload = RpcFrame | RpcFrameAck;

export interface WebRemoteControlRpcTransportOptions extends RpcIdentity {
  sendFrame: (payload: RpcPayload) => void;
  onMessage: (message: Uint8Array, messageSeq: number) => void;
  maxFrameBytes?: number;
  maxRetainedBytes?: number;
  initialPhysicalSeq?: number;
  initialMessageSeq?: number;
  onFault?: (fault: RpcTransportFault) => void;
}

export interface RpcTransportFault {
  reason:
    | "identityMismatch"
    | "invalidFrame"
    | "checksumMismatch"
    | "physicalGap"
    | "messageGap"
    | "fragmentGap"
    | "metadataMismatch"
    | "lengthMismatch"
    | "futureAck"
    | "conflictingDuplicate"
    | "retentionOverflow";
  seq?: number;
  messageSeq?: number;
}

export interface RpcTransportStats {
  outboundBatches: number;
  retainedBytes: number;
  lastAckedMessageSeq: number;
  nextMessageSeq: number;
  sentFrameCount: number;
  replayedFrameCount: number;
  droppedBatches: number;
  disposed: boolean;
}

export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function encodeBase64(bytes: Uint8Array): string {
  // Buffer 原生实现：单次分配。逐字符拼接版本对 1MiB 级分片是分配风暴，
  // 是主进程堆暴涨（V8 OOM）的贡献因素之一。
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

function sameIdentity(expected: RpcIdentity, actual: Partial<RpcIdentity>): boolean {
  return (
    expected.bridgeSessionId === actual.bridgeSessionId &&
    expected.bridgeGeneration === actual.bridgeGeneration &&
    expected.recoveryId === actual.recoveryId
  );
}

function frameFingerprint(frame: RpcFrame): string {
  return JSON.stringify([
    frame.seq,
    frame.messageSeq,
    frame.fragmentIndex,
    frame.fragmentCount,
    frame.messageBytes,
    frame.checksum.value,
    frame.dataBase64,
  ]);
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export class WebRemoteControlRpcTransport {
  private readonly identity: RpcIdentity;
  private readonly sendFrame: (payload: RpcPayload) => void;
  private readonly deliver: (message: Uint8Array, messageSeq: number) => void;
  private readonly maxFrameBytes: number;
  private readonly onFault?: (fault: RpcTransportFault) => void;
  private nextPhysicalSeq: number;
  private nextMessageSeq: number;
  private expectedPhysicalSeq: number;
  private expectedMessageSeq: number;
  private lastAckedMessageSeq = 0;
  private active: { frame: RpcFrame; parts: Uint8Array[]; fingerprints: string[] } | null = null;
  private outbound: Array<{ messageSeq: number; totalBytes: number; frames: RpcFrame[] }> = [];
  private settledBySeq = new Map<number, string>();
  private disposed = false;
  private readonly maxRetainedBytes: number;
  private outboundRetainedBytes = 0;
  private lastSentPhysicalSeq = 0;
  private sentFrameCount = 0;
  private replayedFrameCount = 0;
  private droppedBatches = 0;
  private headerJsonBytes: number | null = null;

  constructor(options: WebRemoteControlRpcTransportOptions) {
    if (
      !options.bridgeSessionId ||
      !validSequence(options.initialPhysicalSeq ?? 1) ||
      !validSequence(options.initialMessageSeq ?? 1)
    )
      throw new Error("invalid transport options");
    this.identity = {
      bridgeSessionId: options.bridgeSessionId,
      ...(options.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: options.bridgeGeneration }),
      ...(options.recoveryId === undefined ? {} : { recoveryId: options.recoveryId }),
    };
    this.sendFrame = options.sendFrame;
    this.deliver = options.onMessage;
    this.onFault = options.onFault;
    this.maxFrameBytes = options.maxFrameBytes ?? SHARED_MAX_FRAME_BYTES;
    this.maxRetainedBytes = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
    if (!Number.isSafeInteger(this.maxRetainedBytes) || this.maxRetainedBytes < 1024)
      throw new Error("invalid maxRetainedBytes");
    if (
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 64 ||
      this.maxFrameBytes > SHARED_MAX_FRAME_BYTES
    )
      throw new Error("invalid maxFrameBytes");
    this.nextPhysicalSeq = options.initialPhysicalSeq ?? 1;
    this.nextMessageSeq = options.initialMessageSeq ?? 1;
    this.expectedPhysicalSeq = this.nextPhysicalSeq;
    this.expectedMessageSeq = this.nextMessageSeq;
  }

  send(message: Uint8Array): void {
    if (this.disposed) return;
    if (
      !(message instanceof Uint8Array) ||
      message.length === 0 ||
      message.length > MAX_MESSAGE_BYTES
    )
      throw new Error("invalid RPC message");
    const checksum = { algorithm: "crc32" as const, value: crc32Hex(message) };
    const fragmentCount = Math.max(
      1,
      Math.ceil(message.length / this.fragmentBytes(message.length, checksum)),
    );
    if (fragmentCount > MAX_FRAGMENTS) throw new Error("RPC message requires too many fragments");
    const messageSeq = this.nextMessageSeq++;
    const frames: RpcFrame[] = [];
    const bytesPerFragment = Math.ceil(message.length / fragmentCount);
    for (let index = 0; index < fragmentCount; index += 1) {
      const seq = this.nextPhysicalSeq++;
      const part = message.subarray(
        index * bytesPerFragment,
        Math.min(message.length, (index + 1) * bytesPerFragment),
      );
      frames.push({
        zcode_type: "rpc-frame",
        ...this.identity,
        seq,
        messageSeq,
        fragmentIndex: index,
        fragmentCount,
        messageBytes: message.length,
        checksum,
        dataBase64: encodeBase64(part),
      });
    }
    this.outbound.push({ messageSeq, totalBytes: message.length, frames });
    this.outboundRetainedBytes += message.length;
    this.enforceRetentionCap();
    this.flush();
  }

  replayUnacknowledged(): boolean {
    if (this.disposed) return false;
    this.lastSentPhysicalSeq = 0;
    this.flush(true);
    return true;
  }

  stats(): RpcTransportStats {
    return {
      outboundBatches: this.outbound.length,
      retainedBytes: this.outboundRetainedBytes,
      lastAckedMessageSeq: this.lastAckedMessageSeq,
      nextMessageSeq: this.nextMessageSeq,
      sentFrameCount: this.sentFrameCount,
      replayedFrameCount: this.replayedFrameCount,
      droppedBatches: this.droppedBatches,
      disposed: this.disposed,
    };
  }

  acceptPayload(payload: unknown): boolean {
    if (this.disposed || typeof payload !== "object" || payload === null) return false;
    const value = payload as Partial<RpcFrame> & Partial<RpcFrameAck>;
    if (!sameIdentity(this.identity, value)) return this.report({ reason: "identityMismatch" });
    if (value.zcode_type === "rpc-frame-ack") return this.acceptAck(value.ackMessageSeq);
    if (value.zcode_type !== "rpc-frame") return this.report({ reason: "invalidFrame" });
    return this.acceptFrame(value as RpcFrame);
  }

  dispose(): void {
    this.disposed = true;
    this.outbound = [];
    this.outboundRetainedBytes = 0;
    this.active = null;
  }

  private fragmentBytes(messageBytes: number, checksum: RpcFrame["checksum"]): number {
    // 帧 JSON = 固定头（identity/seq 等字段，按当前 identity 实测一次）+
    // dataBase64（4*ceil(b/3)）。解析式求解，替代旧版二分探测——探测每次
    // JSON.stringify ~1.4MB 字符串 ×20 轮，大消息时是纯粹的分配风暴。
    this.headerJsonBytes ??=
      new TextEncoder().encode(
        JSON.stringify({
          zcode_type: "rpc-frame",
          ...this.identity,
          seq: 0,
          messageSeq: 0,
          fragmentIndex: 0,
          fragmentCount: 0,
          messageBytes,
          checksum,
          dataBase64: "",
        }),
      ).length + 24; /* seq/messageSeq 位数增长余量 */
    const budget = this.maxFrameBytes - this.headerJsonBytes;
    if (budget < 4) return 1;
    return Math.max(1, Math.floor((budget * 3) / 4));
  }

  private enforceRetentionCap(): void {
    while (this.outboundRetainedBytes > this.maxRetainedBytes && this.outbound.length > 1) {
      const oldest = this.outbound.shift();
      if (!oldest) break;
      this.outboundRetainedBytes -= oldest.totalBytes;
      this.droppedBatches += 1;
      this.report({ reason: "retentionOverflow", messageSeq: oldest.messageSeq });
    }
  }

  private flush(isReplay = false): void {
    // 只发送从未发过的帧（seq 单调递增）。旧版每条新消息都全量重发未 ACK
    // 队列：N 条消息的突发产生 O(N²) 次帧序列化，配合 V8 惰性 GC 直接把
    // 主进程堆推过 4GB 上限。重放语义由 replayUnacknowledged() 显式触发。
    for (const batch of this.outbound) {
      for (const frame of batch.frames) {
        if (frame.seq <= this.lastSentPhysicalSeq) continue;
        this.lastSentPhysicalSeq = frame.seq;
        if (isReplay) this.replayedFrameCount += 1;
        else this.sentFrameCount += 1;
        this.sendFrame(frame);
      }
    }
  }

  private acceptAck(value: unknown): boolean {
    if (!validSequence(value)) return this.report({ reason: "invalidFrame" });
    if (value <= this.lastAckedMessageSeq) return true;
    const highestSent = this.outbound.at(-1)?.messageSeq ?? this.lastAckedMessageSeq;
    if (value > highestSent) return this.report({ reason: "futureAck", messageSeq: value });
    this.lastAckedMessageSeq = value;
    this.outbound = this.outbound.filter((batch) => {
      if (batch.messageSeq > value) return true;
      this.outboundRetainedBytes -= batch.totalBytes;
      return false;
    });
    return true;
  }

  private acceptFrame(frame: RpcFrame): boolean {
    const bytes = decodeBase64(frame.dataBase64);
    if (
      !validSequence(frame.seq) ||
      !validSequence(frame.messageSeq) ||
      !Number.isInteger(frame.fragmentIndex) ||
      !Number.isInteger(frame.fragmentCount) ||
      frame.fragmentIndex < 0 ||
      frame.fragmentIndex >= frame.fragmentCount ||
      frame.fragmentCount < 1 ||
      frame.fragmentCount > MAX_FRAGMENTS ||
      !Number.isInteger(frame.messageBytes) ||
      frame.messageBytes < 1 ||
      frame.messageBytes > MAX_MESSAGE_BYTES ||
      frame.checksum?.algorithm !== "crc32" ||
      !/^[0-9a-f]{8}$/.test(frame.checksum.value) ||
      bytes === null ||
      bytes.length === 0
    )
      return this.report({ reason: "invalidFrame", seq: frame.seq, messageSeq: frame.messageSeq });
    const fingerprint = frameFingerprint(frame);
    const prior = this.settledBySeq.get(frame.seq);
    if (prior !== undefined) {
      if (prior !== fingerprint)
        return this.report({
          reason: "conflictingDuplicate",
          seq: frame.seq,
          messageSeq: frame.messageSeq,
        });
      return true;
    }
    if (frame.seq < this.expectedPhysicalSeq) return true;
    if (frame.seq > this.expectedPhysicalSeq)
      return this.report({ reason: "physicalGap", seq: frame.seq, messageSeq: frame.messageSeq });
    if (frame.messageSeq !== this.expectedMessageSeq)
      return this.report({ reason: "messageGap", seq: frame.seq, messageSeq: frame.messageSeq });
    if (
      this.active &&
      (frame.fragmentCount !== this.active.frame.fragmentCount ||
        frame.messageBytes !== this.active.frame.messageBytes ||
        frame.checksum.value !== this.active.frame.checksum.value)
    )
      return this.report({
        reason: "metadataMismatch",
        seq: frame.seq,
        messageSeq: frame.messageSeq,
      });
    if (this.active && frame.fragmentIndex !== this.active.parts.length)
      return this.report({ reason: "fragmentGap", seq: frame.seq, messageSeq: frame.messageSeq });
    this.active ??= { frame, parts: [], fingerprints: [] };
    this.active.parts.push(bytes);
    this.active.fingerprints.push(fingerprint);
    this.settledBySeq.set(frame.seq, fingerprint);
    this.expectedPhysicalSeq += 1;
    if (this.active.parts.length < frame.fragmentCount) return true;
    const assembled = new Uint8Array(this.active.parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of this.active.parts) {
      assembled.set(part, offset);
      offset += part.length;
    }
    const messageSeq = frame.messageSeq;
    this.active = null;
    if (assembled.length !== frame.messageBytes)
      return this.report({ reason: "lengthMismatch", seq: frame.seq, messageSeq });
    if (crc32Hex(assembled) !== frame.checksum.value)
      return this.report({ reason: "checksumMismatch", seq: frame.seq, messageSeq });
    try {
      this.deliver(assembled, messageSeq);
    } catch {
      return this.report({ reason: "invalidFrame", messageSeq });
    }
    this.expectedMessageSeq += 1;
    this.sendFrame({ zcode_type: "rpc-frame-ack", ...this.identity, ackMessageSeq: messageSeq });
    return true;
  }

  private report(fault: RpcTransportFault): false {
    this.onFault?.(fault);
    return false;
  }
}
