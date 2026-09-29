import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatZCodeAgentProcessName,
  formatZCodeGpuProcessName,
  formatZCodeHostProcessName,
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
} from "../src/process-names.js";

test("进程名前缀是 opencode", () => {
  assert.equal(formatZCodeMainProcessName(), "opencode-main");
  assert.equal(formatZCodeGpuProcessName(), "opencode-gpu");
  assert.equal(formatZCodeHostProcessName(), "opencode-host");
  assert.equal(formatZCodeHostProcessName("local-1"), "opencode-host-local-1");
  assert.equal(formatZCodeUtilityProcessName("sidecar"), "opencode-utility-sidecar");
});

test("renderer 进程名按窗口标题识别", () => {
  assert.equal(formatZCodeRendererProcessName(), "opencode-renderer-main");
  assert.equal(formatZCodeRendererProcessName("OpenCode"), "opencode-renderer-main");
  assert.equal(
    formatZCodeRendererProcessName("Resource Manager"),
    "opencode-renderer-resource-manager",
  );
  assert.equal(
    formatZCodeRendererProcessName("OpenCode - my-repo"),
    "opencode-renderer-remote-my-repo",
  );
  // sanitize 会过滤非 [a-z0-9] 片段：纯中文标题清洗后为空，只保留 renderer 段
  assert.equal(formatZCodeRendererProcessName("任意标题"), "opencode-renderer");
});

test("agent 进程名带 provider 与工作区标签", () => {
  assert.equal(formatZCodeAgentProcessName("glm"), "opencode-agent-glm");
  assert.equal(
    formatZCodeAgentProcessName("glm", "/home/dev/my-project"),
    "opencode-agent-glm-my-project",
  );
});

test("不得回退到 zcode 前缀", () => {
  const names = [
    formatZCodeMainProcessName(),
    formatZCodeGpuProcessName(),
    formatZCodeHostProcessName(),
    formatZCodeRendererProcessName("OpenCode - web"),
  ];
  for (const name of names) {
    assert.doesNotMatch(name, /^zcode-/, `进程名 ${name} 回退到了 zcode 前缀`);
  }
});
