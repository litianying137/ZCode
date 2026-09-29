import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_REPL_MCP_PROCESS_TITLE } from "../src/process-title.js";

test("Node REPL MCP 子进程标题是 opencode-node-repl-mcp", () => {
  assert.equal(NODE_REPL_MCP_PROCESS_TITLE, "opencode-node-repl-mcp");
});
