import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_COMMAND_NAME, CLI_PROCESS_NAME } from "../src/process-name.js";

test("CLI 进程展示名是 codety-cli，命令名保持 zcode 兼容", () => {
  assert.equal(CLI_PROCESS_NAME, "codety-cli");
  // CLI_COMMAND_NAME 属于用户命令与安装脚本兼容边界，刻意保留 zcode。
  assert.equal(CLI_COMMAND_NAME, "zcode");
});
