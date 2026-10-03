import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalServer } from "../src/approval-server.js";

function checkpoint(id: string, session = "session-a", phase = "pre_tool_call") {
  const digest = "a".repeat(64);
  return {
    request: {
      request_id: id,
      phase,
      decision_binding: { digest },
      current_call: {
        session_id: session,
        tool_name: "bash",
        arguments: { command: "node test.js" },
      },
    },
    response: {
      request_id: id,
      phase,
      binding_digest: digest,
      status: "ok",
      decision: "deny",
      reason: "Требуется решение человека.",
    },
  };
}

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-approval-test-"));
  const notices: string[] = [];
  const server = new ApprovalServer({
    stateDirectory: directory,
    openBrowser: false,
    onNotice: (message) => {
      notices.push(message);
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await server.start();
  const url = new URL(server.url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    Origin: url.origin,
    "Content-Type": "application/json",
  };
  return {
    server,
    directory,
    url,
    headers,
    notices,
    async pending(): Promise<any[]> {
      const result = await fetch(`${url.origin}/api/pending`, { headers });
      assert.equal(result.status, 200);
      return ((await result.json()) as any).pending;
    },
    async decide(item: any, decision: string, overrides: Record<string, unknown> = {}) {
      return fetch(`${url.origin}/api/decision`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: item.id,
          phase: item.phase,
          binding_digest: item.binding_digest,
          decision,
          ...overrides,
        }),
      });
    },
  };
}

async function pendingCount(f: Awaited<ReturnType<typeof fixture>>, expected: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pending = await f.pending();
    if (pending.length === expected) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Expected ${expected} pending requests`);
}

test("private control file contains fragment capability; notices do not leak it", async (t) => {
  const f = await fixture(t);
  const control = JSON.parse(await readFile(join(f.directory, "control.json"), "utf8"));
  assert.equal(control.url, f.server.url);
  assert.equal(control.pid, process.pid);
  if (process.platform !== "win32") {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, "control.json"))).mode & 0o777, 0o600);
  }
  const item = checkpoint("private");
  const answer = f.server.ask(item.request, item.response);
  await pendingCount(f, 1);
  assert.ok(f.notices.some((text) => text.includes("control.json")));
  assert.ok(f.notices.every((text) => !text.includes(f.url.hash.slice(1))));
  f.server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
});

test("concurrent approvals are independently bound and cannot be replayed", async (t) => {
  const f = await fixture(t);
  const a = checkpoint("a"),
    b = checkpoint("b", "session-b", "post_tool_call");
  const answerA = f.server.ask(a.request, a.response),
    answerB = f.server.ask(b.request, b.response);
  const pending = await pendingCount(f, 2);
  const first = pending.find((x) => x.request_id === "a"),
    second = pending.find((x) => x.request_id === "b");
  assert.notEqual(first.id, second.id);
  assert.equal((await f.decide(first, "allow", { binding_digest: "b".repeat(64) })).status, 409);
  assert.equal((await f.decide(first, "allow", { phase: "post_tool_call" })).status, 409);
  assert.equal(f.server.pendingCount, 2);
  assert.equal((await f.decide(first, "allow")).status, 200);
  assert.equal(await answerA, "allow");
  assert.equal(f.server.pendingCount, 1);
  assert.equal((await f.decide(first, "reject")).status, 409);
  assert.equal((await f.decide(second, "reject")).status, 200);
  assert.equal(await answerB, "reject");
  await assert.rejects(f.server.ask(a.request, a.response), /already submitted/);
});

test("authorization, host, origin and body restrictions cannot settle approvals", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("protected");
  const answer = f.server.ask(sample.request, sample.response);
  const [item] = await pendingCount(f, 1);
  const body = JSON.stringify({
    id: item.id,
    phase: item.phase,
    binding_digest: item.binding_digest,
    decision: "allow",
  });
  assert.equal((await fetch(`${f.url.origin}/api/pending`)).status, 401);
  const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${f.url.origin}/api/pending`,
      { headers: { ...f.headers, Host: "attacker.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(invalidHostStatus, 421);
  assert.equal(
    (
      await fetch(`${f.url.origin}/api/decision`, {
        method: "POST",
        headers: { ...f.headers, Origin: "https://attacker.invalid" },
        body,
      })
    ).status,
    403,
  );
  const missingOrigin = {
    Authorization: f.headers.Authorization,
    "Content-Type": "application/json",
  };
  assert.equal(
    (await fetch(`${f.url.origin}/api/decision`, { method: "POST", headers: missingOrigin, body }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.url.origin}/api/decision`, {
        method: "POST",
        headers: { ...f.headers, "Content-Type": "text/plain" },
        body,
      })
    ).status,
    415,
  );
  assert.equal(
    (await fetch(`${f.url.origin}/api/decision`, { method: "POST", headers: f.headers, body: "{" }))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(`${f.url.origin}/api/decision`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ huge: "x".repeat(20_000) }),
      })
    ).status,
    413,
  );
  assert.equal(f.server.pendingCount, 1);
  f.server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
});

test("cancelSession rejects only matching waits and close rejects the rest", async (t) => {
  const f = await fixture(t);
  const a = checkpoint("cancel-a"),
    b = checkpoint("cancel-b", "session-b");
  const answerA = f.server.ask(a.request, a.response),
    answerB = f.server.ask(b.request, b.response);
  await pendingCount(f, 2);
  f.server.cancelSession(["session-a"]);
  assert.equal(await answerA, "reject");
  assert.equal(f.server.pendingCount, 1);
  await f.server.close();
  assert.equal(await answerB, "reject");
  assert.equal(f.server.pendingCount, 0);
  await assert.rejects(readFile(join(f.directory, "control.json")), { code: "ENOENT" });
});

test("HTML is static, content is authenticated JSON and CSP prevents inline injection", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("xss");
  sample.response.reason = "</script><script>alert('attacker')</script>";
  const answer = f.server.ask(sample.request, sample.response);
  const [item] = await pendingCount(f, 1);
  assert.equal(item.reason, sample.response.reason);
  const page = await fetch(`${f.url.origin}/`);
  const html = await page.text();
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(page.headers.get("content-security-policy")!, /script-src 'nonce-/);
  assert.ok(!html.includes(sample.response.reason));
  assert.ok(!html.includes(f.url.hash.slice(1)));
  assert.ok(!html.includes("innerHTML"));
  assert.ok(html.includes("textContent"));
  assert.ok(html.includes("инструмент уже выполнился"));
  f.server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
});

test("mismatched classifier verdict never creates an approval", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("mismatch");
  await assert.rejects(
    f.server.ask(sample.request, { ...sample.response, request_id: "other" }),
    /matching, bound/,
  );
  await assert.rejects(
    f.server.ask(sample.request, { ...sample.response, decision: "allow" }),
    /matching, bound/,
  );
  assert.equal(f.server.pendingCount, 0);
});

test("post preview marks truncation and full request download stays immutable and private", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("full-post", "session-a", "post_tool_call");
  const request = {
    ...sample.request,
    current_call: {
      ...sample.request.current_call,
      arguments: { command: "A".repeat(40_000) + "ARGS-END" },
      result: {
        format: "v2_tool_result",
        native: { output: "R".repeat(40_000) + "RESULT-END", metadata: { source: "test" } },
      },
    },
    context: { all: ["retain", "every", "field"] },
  };
  const original = JSON.parse(JSON.stringify(request));
  const answer = f.server.ask(request, sample.response);
  request.current_call.arguments.command = "changed after ask";
  request.current_call.result.native.output = "changed result";
  request.context.all.push("later mutation");
  const [item] = await pendingCount(f, 1);
  assert.match(item.arguments, /Отображение сокращено/);
  assert.match(item.result, /Отображение сокращено/);
  assert.ok(!item.arguments.includes("ARGS-END"));
  assert.ok(!item.result.includes("RESULT-END"));
  const path = `${f.url.origin}/api/request/${item.id}`;
  assert.equal((await fetch(path)).status, 401);
  const download = await fetch(path, { headers: f.headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(await download.json(), original);
  assert.equal((await f.decide(item, "allow")).status, 200);
  assert.equal(await answer, "allow");
  assert.equal((await fetch(path, { headers: f.headers })).status, 404);
});

test("V2 preview includes content and structured output instead of choosing only output", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("mcp-preview", "session-a", "post_tool_call");
  const native = {
    output: { text: "Harmless structured output", value: 42 },
    content: [{ type: "text", text: "Actual V2 returned text" }],
    metadata: { source: "mcp" },
  };
  const request = {
    ...sample.request,
    current_call: {
      ...sample.request.current_call,
      result: { format: "v2_tool_result", native },
    },
  };
  const answer = f.server.ask(request, sample.response);
  const [item] = await pendingCount(f, 1);
  assert.deepEqual(JSON.parse(item.result), {
    content: native.content,
    output: native.output,
    metadata: native.metadata,
  });
  assert.ok(item.result.includes("Actual V2 returned text"));
  assert.equal(item.outcome, "completed");
  const fullRequest = await (
    await fetch(`${f.url.origin}/api/request/${item.id}`, { headers: f.headers })
  ).json();
  assert.deepEqual(fullRequest.current_call.result.native, native);
  const html = await (await fetch(`${f.url.origin}/`)).text();
  assert.ok(html.includes("Предупреждения безопасности OpenCode V2"));
  assert.ok(html.includes("классификатор отклонил эту операцию"));
  assert.ok(html.includes("Скачать полный запрос JSON"));
  assert.ok(html.includes("Предварительный просмотр результата"));
  assert.ok(!html.includes("считает операцию небезопасной"));
  f.server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
});

test("V2 preview prioritizes content before large structured output and arbitrary extensions", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("mcp-extension", "session-a", "post_tool_call");
  const native = {
    "0": "Y".repeat(40_000),
    output: { large: "X".repeat(40_000) },
    content: [{ type: "text", text: "ACTUAL CONTENT FIRST" }],
  };
  const answer = f.server.ask(
    {
      ...sample.request,
      current_call: {
        ...sample.request.current_call,
        result: { format: "v2_tool_result", native },
      },
    },
    sample.response,
  );
  const [item] = await pendingCount(f, 1);
  assert.ok(item.result.includes("ACTUAL CONTENT FIRST"));
  assert.ok(!item.result.includes('"0"'));
  assert.match(item.result, /Отображение сокращено/);
  f.server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
});

test("V2 string content, structured-only output and file content are visible", async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      format: "v2_tool_result",
      native: { output: { text: "structured-only result" } },
      preview: { output: { text: "structured-only result" } },
    },
    {
      format: "v2_tool_result",
      native: { content: "Plain native V2 content" },
      preview: { content: "Plain native V2 content" },
    },
    {
      format: "v2_tool_result",
      native: {
        output: "",
        content: [{ type: "file", mime: "text/plain", uri: "data:text/plain,attachment-content" }],
        metadata: { purpose: "review attachment" },
      },
      preview: {
        output: "",
        content: [{ type: "file", mime: "text/plain", uri: "data:text/plain,attachment-content" }],
        metadata: { purpose: "review attachment" },
      },
    },
  ];
  for (const [index, { preview, ...result }] of cases.entries()) {
    const sample = checkpoint(`nontext-${index}`, "session-a", "post_tool_call");
    const answer = f.server.ask(
      {
        ...sample.request,
        current_call: { ...sample.request.current_call, result },
      },
      sample.response,
    );
    const [item] = await pendingCount(f, 1);
    assert.deepEqual(JSON.parse(item.result), preview);
    assert.equal((await f.decide(item, "allow")).status, 200);
    assert.equal(await answer, "allow");
  }
});

test("V2 execute.after errors have an error preview and an immutable bound error download", async (t) => {
  const f = await fixture(t);
  const sample = checkpoint("error-post", "session-a", "post_tool_call");
  const error = {
    "0": "extension".repeat(10_000),
    _tag: "Tool.Error",
    message: "<img src=x onerror=alert(1)> command failed",
    error: { name: "Error", message: "Permission denied" },
    metadata: { exitCode: 1, partialOutput: "review this failed operation" },
  };
  const event = {
    tool: "bash",
    sessionID: "session-a",
    agent: "build",
    messageID: "message-a",
    id: "tool-a",
    input: { command: "node test.js" },
    status: "error",
    error,
  };
  const request = {
    ...sample.request,
    checkpoint: { raw_input: event, raw_output: error },
    current_call: {
      ...sample.request.current_call,
      message_id: event.messageID,
      hook_call_id: event.id,
      result: { format: "v2_tool_error", native: error },
    },
  };
  const expected = JSON.parse(JSON.stringify(request));
  const answer = f.server.ask(request, sample.response);
  error.message = "Changed after registration";
  error.error.message = "Later mutation";
  const [item] = await pendingCount(f, 1);
  assert.equal(item.outcome, "error");
  assert.deepEqual(JSON.parse(item.result), {
    message: expected.current_call.result.native.message,
    error: expected.current_call.result.native.error,
    metadata: error.metadata,
    _tag: "Tool.Error",
  });
  assert.ok(!item.result.includes("Changed after registration"));
  const download = await fetch(`${f.url.origin}/api/request/${item.id}`, { headers: f.headers });
  assert.deepEqual(await download.json(), expected);
  assert.equal((await f.decide(item, "allow")).status, 200);
  assert.equal(await answer, "allow");
  assert.equal(f.server.pendingCount, 0);
});

test("cancelSession only cancels existing waits; new calls in the same session remain reviewable", async (t) => {
  const f = await fixture(t);
  f.server.cancelSession(["session-a"]);
  const a = checkpoint("after-cancellation");
  const answer = f.server.ask(a.request, a.response);
  const [item] = await pendingCount(f, 1);
  assert.equal(item.session_id, "session-a");
  assert.equal((await f.decide(item, "allow")).status, 200);
  assert.equal(await answer, "allow");
});

test("cancelSession during initial server start cannot leave an orphan approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-approval-start-race-"));
  const server = new ApprovalServer({ stateDirectory: directory, openBrowser: false });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sample = checkpoint("cancel-during-start");
  const answer = server.ask(sample.request, sample.response);
  // ask has reached its first await; the listener and pending entry do not exist yet.
  server.cancelSession(["session-a"]);
  assert.equal(await answer, "reject");
  assert.equal(server.pendingCount, 0);
});
