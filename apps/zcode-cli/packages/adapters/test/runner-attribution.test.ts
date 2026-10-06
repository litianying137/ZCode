import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelRequestAttributionHeaders } from "../src/model/runner-attribution.js";
import { scopeZCodeSourceHeadersForBaseUrl } from "@zcode/shared";

function buildStatusContext(baseURL: string) {
  return {
    requestId: "req_test_1",
    traceId: "trace_test_1",
    queryId: "query_test_1",
    sessionId: "sess_test_1",
    modelRequestSessionType: undefined,
    baseURL,
  };
}

test("第三方 baseURL 不携带 zcode 命名的归因 header", () => {
  for (const baseURL of [
    "https://token-gpt.to/v1",
    "http://127.0.0.1:18080/v1",
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
  ]) {
    const headers = createModelRequestAttributionHeaders(buildStatusContext(baseURL));
    assert.equal(headers["x-zcode-trace-id"], undefined, baseURL);
    assert.equal(headers["x-zcode-session-type"], undefined, baseURL);
    assert.equal(headers["x-request-id"], "req_test_1", baseURL);
    assert.equal(headers["x-session-id"], "test_1", baseURL);
  }
});

test("z.ai / bigmodel 自有域保留 Coding Plan 归因 header", () => {
  for (const baseURL of [
    "https://api.z.ai/v1",
    "https://bigmodel.cn/api/paas/v4",
    "https://open.bigmodel.cn/api/paas/v4",
    "https://sub.example.z.ai/v1",
  ]) {
    const headers = createModelRequestAttributionHeaders(buildStatusContext(baseURL));
    assert.equal(headers["x-zcode-trace-id"], "trace_test_1", baseURL);
    assert.equal(headers["x-zcode-session-type"], "other", baseURL);
  }
});

const SAMPLE_SOURCE_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://zcode.z.ai",
  "User-Agent": "ZCode/3.14.3",
  "X-ZCode-App-Version": "3.14.3",
  "X-Title": "Z Code@electron",
  "X-Release-Channel": "production",
  "X-Client-Language": "zh-CN",
  "X-Client-Timezone": "Asia/Shanghai",
  "X-ZCode-Agent": "glm",
};

test("第三方 baseURL 的 source headers 剥离 zcode 识别信息", () => {
  const scoped = scopeZCodeSourceHeadersForBaseUrl(
    SAMPLE_SOURCE_HEADERS,
    "https://token-gpt.to/v1",
  );
  assert.equal(scoped["HTTP-Referer"], undefined);
  assert.equal(scoped["X-ZCode-App-Version"], undefined);
  assert.equal(scoped["X-ZCode-Agent"], undefined);
  assert.equal(scoped["User-Agent"], "Codety/3.14.3");
  assert.equal(scoped["X-Title"], "Codety@electron");
  assert.equal(scoped["X-Release-Channel"], "production");
});

test("自有域 source headers 保持 ZCode 归因全集", () => {
  for (const baseURL of ["https://bigmodel.cn/api/paas/v4", "https://api.z.ai/v1"]) {
    const scoped = scopeZCodeSourceHeadersForBaseUrl(SAMPLE_SOURCE_HEADERS, baseURL);
    assert.equal(scoped["User-Agent"], "ZCode/3.14.3", baseURL);
    assert.equal(scoped["HTTP-Referer"], "https://zcode.z.ai", baseURL);
    assert.equal(scoped["X-ZCode-Agent"], "glm", baseURL);
  }
});
