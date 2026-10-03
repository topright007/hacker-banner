import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MonitorBackend,
  MonitorError,
  type MonitorCredentials,
  type MonitorDecision,
} from "../src/monitor.js";

const credentials: MonitorCredentials = {
  url: "http://127.0.0.1:8000",
  run_id: "run-test",
  run_token: "test-token-for-registered-run-only",
  workspace: "/workspace",
  policy_version: "prototype-1",
};
const args = { path: "/workspace/README.md" };

function decision(fields: Partial<MonitorDecision> = {}): MonitorDecision {
  return {
    decision_id: "decision-test",
    decision: "ALLOW",
    action_hash: "a".repeat(64),
    policy_version: "prototype-1",
    reason_codes: [],
    findings: [],
    sensitive_run: false,
    approval_id: null,
    permit: "execution-permit",
    ...fields,
  };
}

function scripted(responses: unknown[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.ok(init);
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    assert.ok(responses.length, "Unexpected monitor request");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return Response.json(next);
  };
  return { calls, transport };
}

async function filesystemFixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-monitor-test-"));
  await mkdir(join(root, "workspace"));
  const workspace = await realpath(join(root, "workspace"));
  const file = join(root, "run.credentials.json");
  const localCredentials = { ...credentials, workspace };
  await writeFile(file, JSON.stringify(localCredentials), { mode: 0o600 });
  const ctx = {
    location: { directory: workspace },
    session: {
      get: async (_input: unknown) => ({ location: { directory: workspace } }),
    },
  };
  return {
    root,
    workspace,
    file,
    credentials: localCredentials,
    ctx,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("monitor posts content, evaluates, consumes the permit, and reports the same call", async () => {
  const service = scripted([
    { recorded: true, findings: [], sensitive_run: false },
    decision(),
    { started: true },
    { recorded: true, sensitive_run: true },
  ]);
  const backend = new MonitorBackend(credentials, service.transport);
  await backend.content("ses-test", "prompt:message", "user", "Read README");
  const verdict = await backend.evaluate("ses-test", "message:call", "read", args);
  await backend.start("ses-test", "message:call", "read", args, verdict);
  await backend.after("ses-test", "message:call", "read", args, "completed", { text: "README" });
  assert.equal(backend.monitorRunID, credentials.run_id);
  assert.equal(backend.isBroken, false);
  assert.deepEqual(
    service.calls.map((call) => new URL(call.url).pathname),
    ["/v1/events", "/v1/evaluate", "/v1/start", "/v1/results"],
  );
  for (const call of service.calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.method, "POST");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(
      new Headers(call.init.headers).get("Authorization"),
      `Bearer ${credentials.run_token}`,
    );
    assert.equal(call.body.run_id, credentials.run_id);
    assert.equal(call.body.session_id, "ses-test");
    assert.equal("admin_token" in call.body, false);
  }
  assert.equal(
    new Headers(service.calls[2]!.init.headers).get("X-Execution-Permit"),
    verdict.permit,
  );
  assert.deepEqual(service.calls[1]!.body, service.calls[2]!.body);
  assert.equal(service.calls[3]!.body.permit, verdict.permit);
});

test("approval polling reuses the exact call and only the later ALLOW can start", async () => {
  const service = scripted([
    decision({ decision: "REQUIRE_APPROVAL", approval_id: "approval-test", permit: null }),
    decision(),
    { started: true },
    { recorded: true, sensitive_run: false },
  ]);
  const backend = new MonitorBackend(credentials, service.transport);
  const waiting = await backend.evaluate("session", "call", "read", args);
  assert.equal(waiting.decision, "REQUIRE_APPROVAL");
  const allowed = await backend.evaluate("session", "call", "read", args);
  await backend.start("session", "call", "read", args, allowed);
  await backend.after("session", "call", "read", args, "error", { message: "tool failed" });
  assert.deepEqual(service.calls[0]!.body, service.calls[1]!.body);
  assert.equal(service.calls[3]!.body.status, "error");
});

test("policy blocks permit one rejection error hook without poisoning the monitor", async () => {
  const service = scripted([decision({ decision: "BLOCK", permit: null, reason_codes: ["P01"] })]);
  const backend = new MonitorBackend(credentials, service.transport);
  assert.equal((await backend.evaluate("session", "call", "read", args)).decision, "BLOCK");
  backend.recordDenied("call");
  await backend.after("session", "call", "read", args, "error", {});
  assert.equal(backend.isBroken, false);
  assert.equal(service.calls.length, 1);
  await assert.rejects(backend.after("session", "call", "read", args, "error", {}), /Unobserved/);
  assert.equal(backend.isBroken, true);
});

test("rejected calls cannot produce successful results", async () => {
  const backend = new MonitorBackend(credentials, scripted([]).transport);
  backend.recordDenied("call");
  await assert.rejects(
    backend.after("session", "call", "read", args, "completed", {}),
    /Unobserved/,
  );
  assert.equal(backend.isBroken, true);
});

test("malformed decisions and policy changes fail closed", async () => {
  for (const invalid of [
    {},
    decision({ action_hash: "wrong" }),
    { ...decision(), unexpected: true },
    decision({ permit: null }),
    decision({ decision: "BLOCK" }),
    decision({ decision: "REQUIRE_APPROVAL", permit: null }),
    decision({ policy_version: "changed" }),
    decision({ findings: [3] as any }),
  ]) {
    const service = scripted([invalid]);
    const backend = new MonitorBackend(credentials, service.transport);
    await assert.rejects(backend.evaluate("session", "call", "read", args), MonitorError);
    assert.equal(backend.isBroken, true);
    await assert.rejects(backend.content("session", "event", "user", "hello"), /state incomplete/);
    assert.equal(service.calls.length, 1);
  }
});

test("offline, HTTP errors, and invalid JSON do not expose upstream details", async () => {
  for (const failure of [
    new Error(`network failed with private token ${credentials.run_token}`),
    new Response(`private detail ${credentials.run_token}`, { status: 500 }),
    new Response("not-json", { status: 200 }),
  ]) {
    const backend = new MonitorBackend(credentials, scripted([failure]).transport);
    await assert.rejects(backend.evaluate("session", "call", "read", args), (error: any) => {
      assert.ok(error instanceof MonitorError);
      assert.equal(error.message.includes(credentials.run_token), false);
      assert.equal(error.message.includes("private detail"), false);
      return true;
    });
    assert.equal(backend.isBroken, true);
  }
});

test("monitor permits only loopback HTTP and HTTPS roots without URL credentials", () => {
  for (const url of [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://[::1]:8000",
    "https://monitor.example",
  ]) {
    assert.doesNotThrow(() => new MonitorBackend({ ...credentials, url }));
  }
  for (const url of [
    "http://monitor.example",
    "file:///monitor",
    "https://user:password@monitor.example",
    "https://monitor.example/path",
    "https://monitor.example?token=secret",
    "https://monitor.example#fragment",
  ]) {
    assert.throws(() => new MonitorBackend({ ...credentials, url }), MonitorError);
  }
  assert.throws(
    () => new MonitorBackend({ ...credentials, admin_token: "not allowed" } as any),
    /credentials/,
  );
  assert.throws(() => new MonitorBackend({ ...credentials, run_token: "short" }), /credentials/);
  assert.throws(() => new MonitorBackend(credentials, fetch, 0), /timeout/);
});

test("only explicit validated tool mappings are used", () => {
  const backend = new MonitorBackend(credentials, fetch, 5000, {
    "mcp.fixture.read": "fixture_read_public",
  });
  assert.equal(backend.normalizedTool("mcp.fixture.read"), "fixture_read_public");
  assert.equal(backend.normalizedTool("mcp.fixture.send"), "mcp.fixture.send");
  assert.equal(backend.normalizedTool("toString"), "toString");
  for (const map of [[], { read: "" }, { read: 1 }]) {
    assert.throws(() => new MonitorBackend(credentials, fetch, 5000, map as any), MonitorError);
  }
});

test("private credentials are loaded outside the real workspace", async () => {
  const fixture = await filesystemFixture();
  try {
    const backend = await MonitorBackend.create(
      fixture.ctx,
      { monitorCredentials: fixture.file },
      5000,
    );
    await backend.checkSession(fixture.ctx, "session");
    assert.equal(backend.monitorRunID, credentials.run_id);
    backend.close();
    await assert.rejects(
      MonitorBackend.create(fixture.ctx, { monitorCredentials: "relative.json" }, 5000),
      /absolute/,
    );
    await chmod(fixture.file, 0o644);
    await assert.rejects(
      MonitorBackend.create(fixture.ctx, { monitorCredentials: fixture.file }, 5000),
      /private/,
    );
    await chmod(fixture.file, 0o600);
    const inside = join(fixture.workspace, "credentials.json");
    await writeFile(inside, JSON.stringify(fixture.credentials), { mode: 0o600 });
    await assert.rejects(
      MonitorBackend.create(fixture.ctx, { monitorCredentials: inside }, 5000),
      /outside/,
    );
    const link = join(fixture.root, "outside-link.json");
    await symlink(inside, link);
    await assert.rejects(
      MonitorBackend.create(fixture.ctx, { monitorCredentials: link }, 5000),
      /outside/,
    );
  } finally {
    await fixture.close();
  }
});

test("plugin and session workspace, subpaths, and child sessions are rejected", async () => {
  const fixture = await filesystemFixture();
  try {
    await assert.rejects(
      MonitorBackend.create(
        { location: { directory: fixture.root } },
        { monitorCredentials: fixture.file },
        5000,
      ),
      /workspace/,
    );
    for (const session of [
      { location: { directory: fixture.root } },
      { location: { directory: fixture.workspace }, subpath: "child" },
      { location: { directory: fixture.workspace }, parentID: "parent" },
      {},
    ]) {
      const backend = await MonitorBackend.create(
        fixture.ctx,
        { monitorCredentials: fixture.file },
        5000,
      );
      await assert.rejects(
        backend.checkSession({ session: { get: async () => session } }, "session"),
        /workspace|verify/,
      );
      assert.equal(backend.isBroken, true);
    }
    const backend = await MonitorBackend.create(
      fixture.ctx,
      { monitorCredentials: fixture.file },
      5000,
    );
    await backend.checkSession(fixture.ctx, "first");
    await assert.rejects(backend.checkSession(fixture.ctx, "second"), /span sessions/);
    assert.equal(backend.isBroken, true);
  } finally {
    await fixture.close();
  }
});

test("context and request size limits poison before oversized requests reach the service", async () => {
  for (const invoke of [
    (backend: MonitorBackend) =>
      backend.content("session", "event", "repository", "x".repeat(65537)),
    (backend: MonitorBackend) =>
      backend.evaluate("session", "call", "read", { content: "x".repeat(262145) }),
  ]) {
    const service = scripted([]);
    const backend = new MonitorBackend(credentials, service.transport);
    await assert.rejects(invoke(backend), /bound|256 KiB/);
    assert.equal(backend.isBroken, true);
    assert.equal(service.calls.length, 0);
  }
});

test("arguments must be JSON objects and unchanged while approval is pending", async () => {
  for (const input of [
    null,
    [],
    { x: undefined },
    { x: NaN },
    { x: new Date() },
    { x: [1, , 3] },
  ]) {
    const backend = new MonitorBackend(credentials, scripted([]).transport);
    await assert.rejects(backend.evaluate("session", "call", "read", input), /JSON/);
    assert.equal(backend.isBroken, true);
  }
  const service = scripted([
    decision({ decision: "REQUIRE_APPROVAL", approval_id: "approval", permit: null }),
  ]);
  const backend = new MonitorBackend(credentials, service.transport);
  await backend.evaluate("session", "call", "read", args);
  await assert.rejects(
    backend.evaluate("session", "call", "read", { path: "/different" }),
    /reused/,
  );
  assert.equal(service.calls.length, 1);
});

test("changed arguments or foreign decisions cannot consume a permit", async () => {
  for (const change of ["arguments", "decision", "tool", "blocked"] as const) {
    const service = scripted([decision()]);
    const backend = new MonitorBackend(credentials, service.transport);
    const allowed = await backend.evaluate("session", "call", "read", args);
    await assert.rejects(
      backend.start(
        "session",
        "call",
        change === "tool" ? "write" : "read",
        change === "arguments" ? { path: "/different" } : args,
        change === "decision"
          ? { ...allowed, permit: "foreign-permit" }
          : change === "blocked"
            ? { ...allowed, decision: "BLOCK", permit: null }
            : allowed,
      ),
      /authorized/,
    );
    assert.equal(service.calls.length, 1);
    assert.equal(backend.isBroken, true);
  }
});

test("failed or malformed starts block execution and poison later calls", async () => {
  for (const response of [
    new Error("offline"),
    { started: false },
    { started: true, unexpected: true },
  ]) {
    const service = scripted([decision(), response]);
    const backend = new MonitorBackend(credentials, service.transport);
    const allowed = await backend.evaluate("session", "call", "read", args);
    await assert.rejects(backend.start("session", "call", "read", args, allowed), MonitorError);
    assert.equal(backend.isBroken, true);
    await assert.rejects(backend.evaluate("session", "new-call", "read", args), /incomplete/);
    assert.equal(service.calls.length, 2);
  }
});

test("started and finished call identifiers cannot be evaluated or executed again", async () => {
  for (const finished of [false, true]) {
    const service = scripted([
      decision(),
      { started: true },
      { recorded: true, sensitive_run: false },
    ]);
    const backend = new MonitorBackend(credentials, service.transport);
    const allowed = await backend.evaluate("session", "call", "read", args);
    await backend.start("session", "call", "read", args, allowed);
    if (finished) await backend.after("session", "call", "read", args, "completed", {});
    await assert.rejects(
      backend.evaluate("session", "call", "read", args),
      /executing or finished/,
    );
    assert.equal(service.calls.length, finished ? 3 : 2);
  }
  const service = scripted([decision(), { started: true }]);
  const backend = new MonitorBackend(credentials, service.transport);
  const allowed = await backend.evaluate("session", "call", "read", args);
  await backend.start("session", "call", "read", args, allowed);
  await assert.rejects(backend.start("session", "call", "read", args, allowed), /authorized/);
  assert.equal(service.calls.length, 2);
});

test("missing, changed, duplicate, or unreported results poison the run", async () => {
  const absent = new MonitorBackend(credentials, scripted([]).transport);
  await assert.rejects(
    absent.after("session", "missing", "read", args, "completed", {}),
    /Unobserved/,
  );
  for (const mode of ["arguments", "tool", "offline", "malformed", "duplicate"] as const) {
    const service = scripted([
      decision(),
      { started: true },
      mode === "offline"
        ? new Error("offline")
        : mode === "malformed"
          ? { recorded: false }
          : { recorded: true, sensitive_run: false },
    ]);
    const backend = new MonitorBackend(credentials, service.transport);
    const allowed = await backend.evaluate("session", "call", "read", args);
    await backend.start("session", "call", "read", args, allowed);
    const complete = () =>
      backend.after(
        "session",
        "call",
        mode === "tool" ? "write" : "read",
        mode === "arguments" ? { path: "/different" } : args,
        "completed",
        {},
      );
    if (mode === "duplicate") {
      await complete();
      await assert.rejects(complete(), /Unobserved/);
    } else await assert.rejects(complete(), MonitorError);
    assert.equal(backend.isBroken, true);
  }
});

test("timeout, caller cancellation, and close abort outstanding requests", async () => {
  for (const mode of ["timeout", "caller", "close"] as const) {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requestSignal: AbortSignal | null | undefined;
    const transport: typeof fetch = async (_url, init) => {
      requestSignal = init?.signal;
      entered();
      await new Promise((_resolve, reject) => {
        assert.ok(requestSignal);
        if (requestSignal.aborted) reject(new Error("aborted"));
        else
          requestSignal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
      });
      return Response.json({});
    };
    const backend = new MonitorBackend(credentials, transport, mode === "timeout" ? 10 : 5000);
    const caller = new AbortController();
    const request = backend.evaluate("session", "call", "read", args, caller.signal);
    const rejected = assert.rejects(request, MonitorError);
    await started;
    if (mode === "caller") caller.abort();
    if (mode === "close") backend.close();
    await rejected;
    assert.equal(requestSignal?.aborted, true);
    assert.equal(backend.isBroken, true);
  }
});

test("concurrent reuse of an evaluation identifier poisons both requests", async () => {
  let finish!: (response: Response) => void;
  const transport: typeof fetch = async () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const backend = new MonitorBackend(credentials, transport);
  const first = backend.evaluate("session", "call", "read", args);
  const firstRejected = assert.rejects(first, /cancelled/);
  await assert.rejects(backend.evaluate("session", "call", "read", args), /executing or finished/);
  finish(Response.json(decision()));
  await firstRejected;
  assert.equal(backend.isBroken, true);
});
