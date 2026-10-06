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

test("进程名前缀是 codety", () => {
  assert.equal(formatZCodeMainProcessName(), "codety-main");
  assert.equal(formatZCodeGpuProcessName(), "codety-gpu");
  assert.equal(formatZCodeHostProcessName(), "codety-host");
  assert.equal(formatZCodeHostProcessName("local-1"), "codety-host-local-1");
  assert.equal(formatZCodeUtilityProcessName("sidecar"), "codety-utility-sidecar");
});

test("renderer 进程名按窗口标题识别", () => {
  assert.equal(formatZCodeRendererProcessName(), "codety-renderer-main");
  assert.equal(formatZCodeRendererProcessName("Codety"), "codety-renderer-main");
  assert.equal(
    formatZCodeRendererProcessName("Resource Manager"),
    "codety-renderer-resource-manager",
  );
  assert.equal(
    formatZCodeRendererProcessName("Codety - my-repo"),
    "codety-renderer-remote-my-repo",
  );
  // sanitize 会过滤非 [a-z0-9] 片段：纯中文标题清洗后为空，只保留 renderer 段
  assert.equal(formatZCodeRendererProcessName("任意标题"), "codety-renderer");
});

test("agent 进程名带 provider 与工作区标签", () => {
  assert.equal(formatZCodeAgentProcessName("glm"), "codety-agent-glm");
  assert.equal(
    formatZCodeAgentProcessName("glm", "/home/dev/my-project"),
    "codety-agent-glm-my-project",
  );
});

test("不得回退到 zcode 前缀", () => {
  const names = [
    formatZCodeMainProcessName(),
    formatZCodeGpuProcessName(),
    formatZCodeHostProcessName(),
    formatZCodeRendererProcessName("Codety - web"),
  ];
  for (const name of names) {
    assert.doesNotMatch(name, /^zcode-/, `进程名 ${name} 回退到了 zcode 前缀`);
  }
});
