import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSensor, type ApprovalUI, type SensorOptions } from "../src/sensor.js";
import {
  digest,
  type ClassifierRequest,
  type ClassifierResponse,
  responseFor,
} from "../src/protocol.js";
import { ActionRejectedError } from "../src/gates.js";
import type { Classifier } from "../src/classifier.js";
import { MonitorBackend } from "../src/monitor.js";
import { QuarantineStore } from "../src/quarantine-store.js";

class UI implements ApprovalUI {
  pending: {
    request: ClassifierRequest;
    resolve: (decision: "allow" | "quarantine" | "reject") => void;
  }[] = [];
  async start() {}
  async ask(
    request: ClassifierRequest,
    _response: ClassifierResponse,
  ): Promise<"allow" | "quarantine" | "reject"> {
    return new Promise((resolve) => this.pending.push({ request, resolve }));
  }
  cancelSession(ids: string[]) {
    this.pending
      .filter((p) => ids.includes(p.request.current_call.session_id))
      .forEach((p) => p.resolve("reject"));
  }
  async close() {
    this.pending.forEach((p) => p.resolve("reject"));
  }
}
async function pending(ui: UI, count: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (ui.pending.length >= count) return;
    await delay(5);
  }
  throw new Error(`Expected ${count} approvals, got ${ui.pending.length}`);
}

function fixtureContext() {
  const interrupts: string[] = [];
  const registered = new Map<string, (event: any) => Promise<void>>();
  const events: any[] = [];
  let wake: (() => void) | undefined;
  const emit = (event: any) => {
    events.push(event);
    wake?.();
  };
  const list = async () => ({ location: { directory: "/workspace" }, data: [] });
  const register = (domain: string) => async (name: string, callback: any) => {
    registered.set(`${domain}.${name}`, callback);
    return {
      dispose: async () => {
        registered.delete(`${domain}.${name}`);
      },
    };
  };
  const sessions: Record<string, any> = {
    ses_test: {
      id: "ses_test",
      projectID: "project",
      location: { directory: "/workspace" },
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      permissions: [],
      time: { created: 1, updated: 2 },
    },
  };
  const messages = [
    {
      id: "msg_user",
      sessionID: "ses_test",
      type: "user",
      prompt: [{ type: "text", text: "Read README" }],
    },
    {
      id: "msg_assistant",
      sessionID: "ses_test",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
      content: [
        { type: "tool", id: "call_read", name: "read", input: { path: "/workspace/README.md" } },
      ],
    },
  ];
  const ctx: any = {
    app: { name: "opencode", version: "2.0.22", channel: "latest" },
    location: {
      directory: "/workspace",
      project: { id: "project", directory: "/workspace", canonical: "/workspace" },
    },
    options: {},
    session: {
      hook: register("session"),
      get: async ({ sessionID }: any) => sessions[sessionID],
      context: async () => messages,
      interrupt: async ({ sessionID, resume }: any) => {
        assert.equal(resume, false);
        interrupts.push(sessionID);
        return { interrupted: true };
      },
    },
    tool: {
      hook: register("tool"),
      list: async () => [
        {
          id: "read",
          name: "read",
          description: "Read files",
          input: { type: "object" },
          execute: async () => ({ content: "unused" }),
        },
      ],
    },
    permission: { hook: register("permission"), list: async () => [] },
    shell: { hook: register("shell") },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          while (events.length) {
            const event = events.shift();
            if (event instanceof Error) throw event;
            yield event;
          }
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            const finish = () => {
              signal.removeEventListener("abort", finish);
              wake = undefined;
              resolve();
            };
            wake = finish;
            signal.addEventListener("abort", finish, { once: true });
          });
        }
      },
    },
    agent: { list },
    model: { list },
    provider: { list },
    mcp: { list },
    skill: { list },
    reference: { list },
    command: { list },
    plugin: { list },
    vcs: {
      get: async () => ({ branch: "main" }),
      status: async () => ({}),
      base: async () => ({}),
    },
    worktree: { list: async () => [] },
  };
  return { ctx, interrupts, registered, emit, sessions };
}

async function setup(
  classifier?: Classifier,
  ui = new UI(),
  overrides: SensorOptions = {},
  configure?: (fixture: ReturnType<typeof fixtureContext>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "sensor-v2-unit-"));
  const fixture = fixtureContext();
  configure?.(fixture);
  const hooks = await createSensor(
    fixture.ctx,
    {
      stateDirectory: directory,
      openBrowser: false,
      classifierTimeoutMs: 40,
      apiTimeoutMs: 100,
      ...overrides,
    },
    { classifier, approvals: ui },
  );
  return {
    ...fixture,
    hooks,
    ui,
    directory,
    cleanup: async () => {
      await hooks.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const input = {
  tool: "read",
  sessionID: "ses_test",
  messageID: "msg_assistant",
  agent: "build",
  id: "call_read",
  input: { path: "/workspace/README.md" },
};
const post = () => ({
  ...structuredClone(input),
  status: "completed",
  result: { content: [{ type: "text", text: "untrusted tool content" }], metadata: {} },
});
const allow: Classifier = async (request) =>
  responseFor(request, { status: "ok", decision: "allow", reason: "Allowed", error: null });
const modelContext = (sessionID = "ses_test") => ({
  sessionID,
  agent: "build",
  model: { providerID: "test", id: "test-model" },
  system: [{ type: "text", text: "System" }],
  messages: [{ role: "user", content: [{ type: "text", text: "Read README" }] }],
  options: {},
  tools: { read: { description: "Read files", input: { type: "object" } } },
});

test("registered V2 hooks hold each pre/post and persist bound context", async () => {
  const f = await setup();
  try {
    await f.registered.get("session.context")!(modelContext());
    let done = false;
    const before = f.registered.get("tool.execute.before")!(structuredClone(input)).then(() => {
      done = true;
    });
    await pending(f.ui, 1);
    assert.equal(done, false);
    const first = f.ui.pending[0].request;
    assert.equal(first.contract_version, "2.4.0");
    assert.equal(first.enforcement.user_quarantine, "persist_root_and_descendants_chat_only");
    assert.equal(first.harness.plugin_api, "v2");
    assert.equal(first.current_call.message_id, input.messageID);
    assert.equal(first.current_call.identity.model.model_id, "test-model");
    assert.equal(first.current_call.result, null);
    assert.equal(first.context.sessions[0].active_context.value.length, 2);
    assert.equal(
      first.context.model_context.latest_snapshots.value[0].payload.tools.read.description,
      "Read files",
    );
    f.ui.pending[0].resolve("allow");
    await before;
    done = false;
    const output = post();
    const after = f.registered.get("tool.execute.after")!(output).then(() => {
      done = true;
    });
    await pending(f.ui, 2);
    assert.equal(done, false);
    assert.deepEqual(f.ui.pending[1].request.current_call.result.native, output.result);
    assert.notEqual(first.decision_binding.digest, f.ui.pending[1].request.decision_binding.digest);
    f.ui.pending[1].resolve("allow");
    await after;
    const files = await readdir(join(f.directory, "requests"));
    assert.equal(files.length, 2);
    for (const file of files) {
      const data = JSON.parse(await readFile(join(f.directory, "requests", file), "utf8"));
      const { decision_binding, ...unsigned } = data;
      assert.equal(digest(unsigned), decision_binding.digest);
    }
  } finally {
    await f.cleanup();
  }
});

test("cancelled confirmation cancels only that call and later model/tool requests work", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(before, (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assert.match(error.message, /Предупреждение: вызов инструмента заблокирован/);
      assert.match(error.message, /Инструмент: "read"/);
      assert.match(error.message, /Причина: "Тестовая заглушка/);
      assert.doesNotMatch(error.message, /Подозревается хакерская атака/);
      return true;
    });
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await rejected;
    for (const name of [
      "session.context",
      "session.model.request",
      "session.http.request",
      "session.experimental.ws.send",
    ])
      await f.hooks[name]({
        ...modelContext(),
        kind: "primary",
        request: new Request("https://example.test/model"),
        frame: "{}",
      });
    const next = f.hooks["tool.execute.before"]({ ...structuredClone(input), id: "next" });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    assert.equal(f.interrupts.length, 0);
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(decisions.every((entry) => entry.scope === "call"));
    assert.equal(
      decisions.filter(
        (entry) => entry.source === "plugin.user_override" && entry.decision === "deny",
      ).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("post error is a separate checkpoint with non-enumerable Error details", async () => {
  const f = await setup();
  try {
    const error = Object.assign(new Error("Tool failed before returning content"), {
      _tag: "Tool.Error",
      metadata: { retryable: true },
    });
    const after = f.hooks["tool.execute.after"]({
      ...structuredClone(input),
      status: "error",
      error,
    });
    await pending(f.ui, 1);
    const request = f.ui.pending[0].request;
    assert.equal(request.current_call.status, "error");
    assert.equal(request.current_call.result.format, "v2_tool_error");
    assert.equal(request.current_call.result.native.message, error.message);
    assert.equal(request.checkpoint.raw_input.error.message, error.message);
    assert.deepEqual(request.current_call.arguments, input.input);
    f.ui.pending[0].resolve("allow");
    await after;
  } finally {
    await f.cleanup();
  }
});

test("post rejection removes all original result fields and permits continuation", async () => {
  const f = await setup();
  try {
    const event = {
      ...post(),
      result: {
        content: [{ type: "text", text: "SECRET_CONTENT" }],
        output: { secret: "SECRET_OUTPUT" },
        metadata: { secret: "SECRET_METADATA" },
        extension: "SECRET_EXTENSION",
      },
    };
    const after = f.hooks["tool.execute.after"](event);
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await after;
    assert.deepEqual(Object.keys(event.result), ["content"]);
    assert.match(String(event.result.content), /передача результата заблокирована/);
    assert.match(String(event.result.content), /Инструмент: "read"/);
    assert.match(String(event.result.content), /Причина: "Тестовая заглушка/);
    assert.doesNotMatch(JSON.stringify(event.result), /SECRET/);
    await f.hooks["session.context"](modelContext());
    const next = f.hooks["tool.execute.before"]({ ...input, id: "after_rejected_post" });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("post rejection replaces the entire native tool error", async () => {
  const f = await setup();
  try {
    const event = {
      ...structuredClone(input),
      status: "error",
      error: Object.assign(new Error("SECRET_MESSAGE"), {
        _tag: "Tool.Error",
        error: "SECRET_CAUSE",
        metadata: { secret: "SECRET_METADATA" },
      }),
    };
    const after = f.hooks["tool.execute.after"](event);
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await after;
    assert.match(event.error.message, /передача ошибки заблокирована/);
    assert.match(event.error.message, /Инструмент: "read"/);
    assert.match(event.error.message, /Причина: "Тестовая заглушка/);
    assert.doesNotMatch(JSON.stringify(event.error), /SECRET/);
    assert.equal(event.error._tag, "Tool.Error");
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("real classifier denial details reach pre, result and error feedback", async () => {
  const reason = "Обнаружена попытка изменить инструкции агента в данных инструмента.";
  const deny: Classifier = async (request) =>
    responseFor(request, { status: "ok", decision: "deny", reason, error: null });
  for (const outcome of ["pre", "completed", "error"] as const) {
    const f = await setup(deny);
    try {
      const event: any =
        outcome === "pre"
          ? structuredClone(input)
          : outcome === "error"
            ? { ...input, status: "error", error: new Error("RAW_PRIVATE_ERROR") }
            : { ...post(), result: { content: "RAW_PRIVATE_RESULT" } };
      let message = "";
      const running =
        outcome === "pre"
          ? assert.rejects(f.hooks["tool.execute.before"](event), (error: unknown) => {
              assert.ok(error instanceof ActionRejectedError);
              message = error.message;
              return true;
            })
          : f.hooks["tool.execute.after"](event);
      await pending(f.ui, 1);
      f.ui.pending[0].resolve("reject");
      await running;
      if (outcome !== "pre")
        message = outcome === "error" ? event.error.message : event.result.content;
      assert.match(message, /Инструмент: "read"/);
      assert.ok(message.includes(`Причина: ${JSON.stringify(reason)}`));
      assert.equal(message.split("\n").length, 3);
      assert.doesNotMatch(message, /RAW_PRIVATE|Тестовый карантин/);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("post confirmation failure reports a brief technical cause without exposing diagnostics", async () => {
  const ui = new UI();
  ui.ask = async () => {
    throw new Error("PRIVATE_UI_DIAGNOSTIC");
  };
  const deny: Classifier = async (request) =>
    responseFor(request, {
      status: "ok",
      decision: "deny",
      reason: "Непроверенный внешний источник",
      error: null,
    });
  const f = await setup(deny, ui);
  try {
    const event = { ...post(), result: { content: "PRIVATE_TOOL_OUTPUT" } };
    await f.hooks["tool.execute.after"](event);
    assert.match(event.result.content, /передача результата заблокирована/);
    assert.match(event.result.content, /Причина: "Форма подтверждения OpenCode недоступна/);
    assert.equal(event.result.content.split("\n").length, 3);
    assert.doesNotMatch(
      event.result.content,
      /PRIVATE_|Подозревается хакерская атака|Пользователь отклонил/,
    );
  } finally {
    await f.cleanup();
  }
});

test("quarantine reports the captured tool identity when a pending event changes", async () => {
  const f = await setup();
  try {
    const event = structuredClone(input);
    const rejected = assert.rejects(f.hooks["tool.execute.before"](event), (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assert.match(error.message, /Инструмент: "read"/);
      assert.match(error.message, /Аргументы или результат изменились/);
      assert.doesNotMatch(error.message, /forged_tool|Подозревается хакерская атака/);
      return true;
    });
    await pending(f.ui, 1);
    event.tool = "forged_tool";
    f.ui.pending[0].resolve("allow");
    await rejected;
  } finally {
    await f.cleanup();
  }
});

test("rejecting one parallel checkpoint does not reject sibling or child operations", async () => {
  const f = await setup();
  try {
    f.sessions.ses_child = {
      ...f.sessions.ses_test,
      id: "ses_child",
      parentID: input.sessionID,
    };
    f.hooks.event({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: input.sessionID },
    });
    const first = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(first, ActionRejectedError);
    const sibling = f.hooks["tool.execute.before"]({ ...input, id: "sibling" });
    const child = f.hooks["tool.execute.before"]({ ...input, sessionID: "ses_child", id: "child" });
    await pending(f.ui, 3);
    const denied = f.ui.pending.find((p) => p.request.current_call.tool_call_id === input.id)!;
    denied.resolve("reject");
    await rejected;
    for (const item of f.ui.pending.filter((p) => p !== denied)) item.resolve("allow");
    await Promise.all([sibling, child]);
    await f.hooks["session.context"](modelContext());
    await f.hooks["session.context"]({ ...modelContext(), sessionID: "ses_child" });
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("classifier timeout alone fails open with an unavailable audit decision", async () => {
  const f = await setup(async () => new Promise(() => {}));
  try {
    await f.hooks["tool.execute.before"](structuredClone(input));
    assert.equal(f.ui.pending.length, 0);
    assert.equal(f.interrupts.length, 0);
    const decisions = await readFile(join(f.directory, "decisions.jsonl"), "utf8");
    assert.match(decisions, /CLASSIFIER_TIMEOUT/);
    assert.match(decisions, /unavailable/);
  } finally {
    await f.cleanup();
  }
});

test("approval UI failure is fail closed, not a classifier outage", async () => {
  const ui = new UI();
  ui.ask = async () => {
    throw new Error("UI disconnected");
  };
  const f = await setup(undefined, ui);
  try {
    await assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      ActionRejectedError,
    );
    await f.hooks["session.context"](modelContext());
  } finally {
    await f.cleanup();
  }
});

test("startup UI failure denies tool calls but permits text conversation", async () => {
  const ui = new UI();
  ui.start = async () => {
    throw new Error("Port unavailable");
  };
  const f = await setup(undefined, ui);
  try {
    assert.ok(f.registered.has("tool.execute.before"));
    assert.ok(f.registered.has("session.http.request"));
    await assert.rejects(
      f.registered.get("tool.execute.before")!(structuredClone(input)),
      ActionRejectedError,
    );
    await f.registered.get("session.context")!(modelContext());
    assert.equal(ui.pending.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("audit startup failure and invalid options retain a blocking plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sensor-v2-audit-fail-"));
  const file = join(directory, "not-a-directory");
  await writeFile(file, "x");
  try {
    for (const options of [{ stateDirectory: file }, { classifierTimeoutMs: -1 }]) {
      const f = await setup(undefined, new UI(), options);
      try {
        const context = modelContext();
        const unchanged = structuredClone(context);
        await f.registered.get("session.context")!(context);
        assert.deepEqual(
          context,
          unchanged,
          "Stub startup failure must not alter the model context or tool map",
        );
        await assert.rejects(
          f.registered.get("tool.execute.before")!(structuredClone(input)),
          ActionRejectedError,
        );
        assert.equal(f.ui.pending.length, 0);
      } finally {
        await f.cleanup();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutation while approval waits invalidates the one-time approval", async () => {
  const f = await setup();
  try {
    const event = structuredClone(input);
    const before = f.hooks["tool.execute.before"](event);
    const rejected = assert.rejects(before, ActionRejectedError);
    await pending(f.ui, 1);
    event.input.path = "/workspace/changed";
    assert.equal(f.ui.pending[0].request.current_call.arguments.path, input.input.path);
    f.ui.pending[0].resolve("allow");
    await rejected;
  } finally {
    await f.cleanup();
  }
});

test("post mutation after approval hides the changed output without blocking another action", async () => {
  const f = await setup();
  try {
    const event = post();
    const after = f.hooks["tool.execute.after"](event);
    await pending(f.ui, 1);
    event.result.content = [{ type: "text", text: "UNAPPROVED_CHANGE" }];
    f.ui.pending[0].resolve("allow");
    await after;
    assert.doesNotMatch(JSON.stringify(event.result), /UNAPPROVED_CHANGE/);
    assert.match(String(event.result.content), /передача результата заблокирована/);
    assert.match(String(event.result.content), /Аргументы или результат изменились/);
    assert.doesNotMatch(String(event.result.content), /Подозревается хакерская атака/);
    await f.hooks["session.context"](modelContext());
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("native interruption cancels current confirmation without blocking the next turn", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(before, ActionRejectedError);
    await pending(f.ui, 1);
    f.emit({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_test", reason: "user" },
    });
    await rejected;
    const next = f.hooks["tool.execute.before"]({ ...input, messageID: "msg_next", id: "next" });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    const audit = await readFile(join(f.directory, "decisions.jsonl"), "utf8");
    const decisions = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      decisions.filter(
        (entry) => entry.source === "plugin.user_override" && entry.decision === "deny",
      ).length,
      0,
    );
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("cancellation during context collection cannot later open an approval", async () => {
  let unblock!: () => void;
  let collecting!: () => void;
  const started = new Promise<void>((resolve) => {
    collecting = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const f = await setup(undefined, new UI(), {}, ({ ctx }) => {
    const original = ctx.session.context;
    ctx.session.context = async (...args: any[]) => {
      collecting();
      await blocked;
      return original(...args);
    };
  });
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(before, ActionRejectedError);
    await started;
    f.hooks.event({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_test", reason: "user" },
    });
    unblock();
    await rejected;
    assert.equal(f.ui.pending.length, 0);
  } finally {
    unblock();
    await f.cleanup();
  }
});

test("normal child completion does not cancel a parent checkpoint", async () => {
  const f = await setup();
  try {
    f.hooks.event({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_test" },
    });
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    await pending(f.ui, 1);
    f.hooks.event({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } });
    f.ui.pending[0].resolve("allow");
    await before;
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("CodeMode outer and nested hooks share IDs without holding a lock across execution", async () => {
  const f = await setup(allow);
  try {
    const outer = { ...structuredClone(input), tool: "execute", input: { code: "await read();" } };
    await f.hooks["tool.execute.before"](outer);
    await f.hooks["tool.execute.before"](structuredClone(input));
    await f.hooks["tool.execute.after"](post());
    await f.hooks["tool.execute.after"]({
      ...outer,
      status: "completed",
      result: { content: "done" },
    });
    const files = await readdir(join(f.directory, "requests"));
    assert.equal(files.length, 4);
    const requests = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await readFile(join(f.directory, "requests", file), "utf8")),
      ),
    );
    assert.equal(new Set(requests.map((request) => request.request_id)).size, 4);
    assert.equal(new Set(requests.map((request) => request.current_call.tool_call_id)).size, 1);
  } finally {
    await f.cleanup();
  }
});

test("permission observer never weakens the harness deny policy", async () => {
  const f = await setup(allow);
  try {
    const event = {
      sessionID: "ses_test",
      action: "write",
      resources: ["*"],
      effect: "deny",
      message: "Policy denied",
    };
    await f.hooks["permission.evaluate"](event);
    assert.equal(event.effect, "deny");
  } finally {
    await f.cleanup();
  }
});

test("event stream failure cancels approvals but preserves text conversation", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(before, ActionRejectedError);
    await pending(f.ui, 1);
    f.emit(new Error("stream lost"));
    await rejected;
    await f.hooks["session.context"](modelContext());
  } finally {
    await f.cleanup();
  }
});

test("invalid arguments cancel only that action and do not latch the session", async () => {
  const f = await setup(allow);
  try {
    await assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, input: { path: "\ud800" } }),
      ActionRejectedError,
    );
    await f.hooks["session.model.request"]({ ...modelContext(), kind: "primary", headers: {} });
    await f.hooks["tool.execute.before"]({ ...input, id: "valid_after_invalid" });
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("overlapping identical CodeMode calls keep both pre timestamps ambiguous", async () => {
  const f = await setup(allow);
  try {
    // Native IDs and inputs are identical; both calls are outstanding before
    // either post hook. The second invocation can finish first.
    await f.hooks["tool.execute.before"](structuredClone(input));
    await delay(2);
    await f.hooks["tool.execute.before"](structuredClone(input));
    await f.hooks["tool.execute.after"]({
      ...post(),
      result: { content: "second call finished first" },
    });
    await f.hooks["tool.execute.after"]({
      ...post(),
      result: { content: "first call finished last" },
    });
    const files = await readdir(join(f.directory, "requests"));
    const requests = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await readFile(join(f.directory, "requests", file), "utf8")),
      ),
    );
    const posts = requests.filter((request) => request.phase === "post_tool_call");
    assert.equal(posts.length, 2);
    for (const request of posts)
      assert.equal(request.current_call.timestamps.pre_observed_at_ms, null);
    // A fresh call after the ambiguous batch drains can be paired again.
    await f.hooks["tool.execute.before"](structuredClone(input));
    await f.hooks["tool.execute.after"](post());
    const allFiles = await readdir(join(f.directory, "requests"));
    const allRequests = await Promise.all(
      allFiles.map(async (file) =>
        JSON.parse(await readFile(join(f.directory, "requests", file), "utf8")),
      ),
    );
    const last = allRequests
      .sort((left, right) => left.snapshot.sequence - right.snapshot.sequence)
      .at(-1)!;
    assert.equal(typeof last.current_call.timestamps.pre_observed_at_ms, "number");
  } finally {
    await f.cleanup();
  }
});

test("enabled false is a no-op before SDK, version, options, services or state access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sensor-v2-disabled-"));
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error("Disabled sensor accessed a dependency");
      },
    },
  );
  try {
    const hooks = await createSensor(
      forbidden as any,
      {
        enabled: false,
        stateDirectory: join(directory, "never-created"),
        classifierTimeoutMs: -1,
        openBrowser: "invalid while disabled",
      },
      forbidden as any,
    );
    assert.deepEqual(Object.keys(hooks), ["dispose"]);
    await hooks.dispose();
    await hooks.dispose();
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit enabled true retains the default classifier approval path", async () => {
  const f = await setup(undefined, new UI(), { enabled: true });
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    await pending(f.ui, 1);
    assert.ok(f.registered.has("session.model.request"));
    f.ui.pending[0].resolve("allow");
    await before;
  } finally {
    await f.cleanup();
  }
});

test("invalid enabled values never disable registered enforcement", async () => {
  for (const enabled of ["false", "true", 0, 1, null]) {
    const f = await setup(undefined, new UI(), { enabled: enabled as any });
    try {
      assert.ok(f.registered.has("tool.execute.before"));
      await assert.rejects(
        f.hooks["tool.execute.before"](structuredClone(input)),
        ActionRejectedError,
      );
      assert.equal(f.ui.pending.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("scalar, array and null options fail closed rather than bypassing setup", async () => {
  for (const options of [false, "false", 0, [], null]) {
    const f = fixtureContext();
    const ui = new UI();
    let serviceStarts = 0;
    ui.start = async () => {
      serviceStarts++;
    };
    const hooks = await createSensor(f.ctx, options, { approvals: ui });
    try {
      assert.ok(f.registered.has("tool.execute.before"));
      await assert.rejects(
        hooks["tool.execute.before"](structuredClone(input)),
        ActionRejectedError,
      );
      assert.equal(serviceStarts, 0);
      assert.equal(ui.pending.length, 0);
    } finally {
      await hooks.dispose();
    }
  }
});

test("explicit quarantine blocks parallel and child tools without interrupting text conversation", async () => {
  const f = await setup(undefined, new UI(), {}, ({ sessions }) => {
    sessions.ses_child = { ...sessions.ses_test, id: "ses_child", parentID: "ses_test" };
    sessions.ses_other = { ...sessions.ses_test, id: "ses_other" };
  });
  try {
    const first = f.hooks["tool.execute.before"]({ ...input, id: "quarantine" });
    const sibling = f.hooks["tool.execute.before"]({ ...input, id: "sibling" });
    const child = f.hooks["tool.execute.before"]({ ...input, sessionID: "ses_child", id: "child" });
    const refused = [first, sibling, child].map((p) => assert.rejects(p, ActionRejectedError));
    await pending(f.ui, 3);
    f.ui.pending
      .find((p) => p.request.current_call.tool_call_id === "quarantine")!
      .resolve("quarantine");
    // Even an already-submitted parallel allow cannot undo quarantine.
    f.ui.pending.find((p) => p.request.current_call.tool_call_id === "sibling")!.resolve("allow");
    await Promise.all(refused);
    for (const sessionID of ["ses_test", "ses_child"]) {
      for (const name of ["context", "compaction", "generate"]) {
        const event = modelContext(sessionID);
        await f.hooks[`session.${name}`](event);
        assert.deepEqual(event.tools, {});
        assert.match(event.system.map((part) => part.text).join("\n"), /только общение/);
        assert.equal(event.messages.length, 1);
      }
      await assert.rejects(
        f.hooks["tool.execute.before"]({ ...input, sessionID, id: "later" }),
        /режим карантина/,
      );
      const result = { ...post(), sessionID };
      await f.hooks["tool.execute.after"](result);
      assert.doesNotMatch(JSON.stringify(result.result), /untrusted tool content/);
      assert.match(String(result.result.content), /Режим карантина/);
    }
    assert.equal(f.ui.pending.length, 3, "Quarantine must not ask again");
    const unrelated = modelContext("ses_other");
    await f.hooks["session.context"](unrelated);
    assert.ok(unrelated.tools.read);
    const other = f.hooks["tool.execute.before"]({ ...input, sessionID: "ses_other", id: "other" });
    await pending(f.ui, 4);
    f.ui.pending[3].resolve("allow");
    await other;
    assert.equal(f.interrupts.length, 0);
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(
      decisions.filter(
        (d) =>
          d.source === "plugin.user_override" &&
          d.scope === "session_tree" &&
          d.quarantine_root_session_id === "ses_test",
      ).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("post quarantine withholds the complete result/error and blocks all later tools", async () => {
  for (const status of ["completed", "error"]) {
    const f = await setup();
    try {
      const event: any =
        status === "error"
          ? {
              ...input,
              status,
              error: Object.assign(new Error("PRIVATE_ERROR"), {
                metadata: { secret: "PRIVATE_METADATA" },
              }),
            }
          : {
              ...post(),
              result: {
                content: "PRIVATE_RESULT",
                metadata: { secret: "PRIVATE_METADATA" },
                extension: "PRIVATE_EXTENSION",
              },
            };
      const held = f.hooks["tool.execute.after"](event);
      await pending(f.ui, 1);
      f.ui.pending[0].resolve("quarantine");
      await held;
      assert.doesNotMatch(
        JSON.stringify(status === "error" ? event.error : event.result),
        /PRIVATE_/,
      );
      const message = status === "error" ? event.error.message : event.result.content;
      assert.equal(message.split("\n").length, 3);
      assert.match(message, /инструмент выполнен/);
      await assert.rejects(
        f.hooks["tool.execute.before"]({ ...input, id: "after_quarantine" }),
        ActionRejectedError,
      );
      assert.equal(f.ui.pending.length, 1);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("quarantine survives completion, interruption and plugin restart, including unseen descendants", async () => {
  const f = await setup();
  let restarted: Record<string, any> | undefined;
  try {
    const refused = assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      ActionRejectedError,
    );
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("quarantine");
    await refused;
    for (const type of [
      "session.execution.succeeded",
      "session.execution.interrupted",
      "session.execution.failed",
    ])
      f.hooks.event({ type, data: { sessionID: "ses_test" } });
    await f.hooks.dispose();
    const ctx = fixtureContext();
    ctx.sessions.ses_new_child = {
      ...ctx.sessions.ses_test,
      id: "ses_new_child",
      parentID: "ses_test",
    };
    let classifierCalls = 0;
    const ui = new UI();
    restarted = await createSensor(
      ctx.ctx,
      { stateDirectory: f.directory, apiTimeoutMs: 100 },
      {
        approvals: ui,
        classifier: async () => {
          classifierCalls++;
          throw new Error("Unavailable");
        },
      },
    );
    for (const sessionID of ["ses_test", "ses_new_child"]) {
      await assert.rejects(
        restarted["tool.execute.before"]({ ...input, sessionID }),
        ActionRejectedError,
      );
      const event = modelContext(sessionID);
      await restarted["session.context"](event);
      assert.deepEqual(event.tools, {});
    }
    assert.equal(classifierCalls, 0, "Classifier fail-open must never bypass quarantine");
    assert.equal(ui.pending.length, 0);
  } finally {
    await restarted?.dispose();
    await f.cleanup();
  }
});

test("quarantine arriving while another classifier waits prevents its later allow", async () => {
  let release!: (response: ClassifierResponse) => void;
  let delayedRequest: ClassifierRequest | undefined;
  const f = await setup(
    async (request) => {
      if (request.current_call.tool_call_id === "delayed") {
        delayedRequest = request;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return responseFor(request, {
        status: "ok",
        decision: "deny",
        reason: "Untrusted input",
        error: null,
      });
    },
    new UI(),
    { classifierTimeoutMs: 1000 },
  );
  try {
    const quarantine = assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, id: "quarantine" }),
      ActionRejectedError,
    );
    const delayed = assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, id: "delayed" }),
      ActionRejectedError,
    );
    await pending(f.ui, 1);
    for (let i = 0; i < 100 && !delayedRequest; i++) await delay(5);
    assert.ok(delayedRequest);
    f.ui.pending[0].resolve("quarantine");
    await quarantine;
    release(
      responseFor(delayedRequest, {
        status: "ok",
        decision: "allow",
        reason: "Allowed",
        error: null,
      }),
    );
    await delayed;
    assert.equal(f.ui.pending.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("unreadable quarantine state blocks tools but keeps the model conversation available", async () => {
  const f = await setup(allow);
  try {
    await writeFile(join(f.directory, "quarantine"), "not a directory");
    await assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      /Не удалось проверить или сохранить/,
    );
    const event = modelContext();
    await f.hooks["session.context"](event);
    assert.deepEqual(event.tools, {});
    assert.equal(event.messages.length, 1);
    assert.equal(f.ui.pending.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("failed quarantine persistence still blocks this instance immediately", async () => {
  const f = await setup();
  try {
    const refused = assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      /Не удалось проверить или сохранить/,
    );
    await pending(f.ui, 1);
    await writeFile(join(f.directory, "quarantine"), "not a directory");
    f.ui.pending[0].resolve("quarantine");
    await refused;
    await assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, id: "next" }),
      ActionRejectedError,
    );
    assert.equal(f.ui.pending.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("another plugin instance quarantines a pending form without another user answer", async () => {
  const f = await setup();
  const secondUI = new UI();
  let second: Record<string, any> | undefined;
  try {
    second = await createSensor(
      fixtureContext().ctx,
      { stateDirectory: f.directory, apiTimeoutMs: 100 },
      { approvals: secondUI },
    );
    const held = assert.rejects(
      second["tool.execute.before"]({ ...input, id: "other_instance" }),
      ActionRejectedError,
    );
    await pending(secondUI, 1);
    const denied = assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      ActionRejectedError,
    );
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("quarantine");
    await denied;
    await held;
    const event = modelContext();
    await second["session.context"](event);
    assert.deepEqual(event.tools, {});
    assert.equal(secondUI.pending.length, 1);
  } finally {
    await second?.dispose();
    await f.cleanup();
  }
});

function nestedSessions(fixture: ReturnType<typeof fixtureContext>): void {
  const { sessions } = fixture;
  for (const [id, parentID] of [
    ["ses_parent", "ses_test"],
    ["ses_grandchild", "ses_parent"],
    ["ses_sibling", "ses_test"],
    ["ses_unrelated", undefined],
  ] as const)
    sessions[id] = { ...sessions.ses_test, id, ...(parentID ? { parentID } : {}) };
}

async function assertTreeChatOnly(hooks: Record<string, any>, sessionIDs: string[]): Promise<void> {
  for (const sessionID of sessionIDs) {
    for (const name of ["context", "compaction", "generate"]) {
      const context = modelContext(sessionID);
      const messages = structuredClone(context.messages);
      await hooks[`session.${name}`](context);
      assert.deepEqual(context.tools, {}, `${sessionID}/${name} restored tools`);
      assert.deepEqual(context.messages, messages);
      assert.match(context.system.map((part) => part.text).join("\n"), /только общение/);
    }
    await assert.rejects(
      hooks["tool.execute.before"]({ ...input, sessionID, id: `blocked_${sessionID}` }),
      ActionRejectedError,
    );
    const result = {
      ...post(),
      sessionID,
      id: `late_${sessionID}`,
      result: { content: "PRIVATE_TREE_RESULT", metadata: { secret: "PRIVATE_TREE_METADATA" } },
    };
    await hooks["tool.execute.after"](result);
    assert.doesNotMatch(JSON.stringify(result.result), /PRIVATE_TREE_/);
    assert.match(String(result.result.content), /Режим карантина/);
  }
}

test("grandchild pre quarantine covers the verified root tree and pending parallel allow decisions", async () => {
  const ui = new UI();
  const cancelled: string[][] = [];
  // Simulate replies already accepted by the host: cancelling their cards cannot
  // withdraw those replies, so the execution barrier must reject them itself.
  ui.cancelSession = (ids: string[]) => {
    cancelled.push(ids);
  };
  const f = await setup(undefined, ui, {}, nestedSessions);
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let resolvingRoot = false;
  let rootReleased = false;
  let siblingReleased = false;
  try {
    const child = assert.rejects(
      f.hooks["tool.execute.before"]({
        ...input,
        sessionID: "ses_grandchild",
        id: "child_quarantine",
      }),
      ActionRejectedError,
    );
    const root = assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, id: "root_wait" }).then(() => {
        rootReleased = true;
      }),
      ActionRejectedError,
    );
    const sibling = assert.rejects(
      f.hooks["tool.execute.before"]({
        ...input,
        sessionID: "ses_sibling",
        id: "sibling_wait",
      }).then(() => {
        siblingReleased = true;
      }),
      ActionRejectedError,
    );
    await pending(f.ui, 3);
    const childApproval = f.ui.pending.find(
      (item) => item.request.current_call.tool_call_id === "child_quarantine",
    )!;
    assert.equal(childApproval.request.context.session_scope.root_resolved, true);
    assert.equal(childApproval.request.context.session_scope.root_session_id, "ses_test");
    const originalGet = f.ctx.session.get;
    f.ctx.session.get = async (request: any, options: any) => {
      if (request.sessionID === "ses_grandchild") {
        resolvingRoot = true;
        await lookupGate;
      }
      return originalGet(request, options);
    };
    childApproval.resolve("quarantine");
    for (let i = 0; i < 100 && !resolvingRoot; i++) await delay(1);
    assert.equal(resolvingRoot, true, "Quarantine must freshly verify the root ancestry");
    f.ui.pending
      .find((item) => item.request.current_call.tool_call_id === "root_wait")!
      .resolve("allow");
    f.ui.pending
      .find((item) => item.request.current_call.tool_call_id === "sibling_wait")!
      .resolve("allow");
    await delay(15);
    assert.equal(
      rootReleased,
      false,
      "Parallel root allow escaped while quarantine ancestry was resolving",
    );
    assert.equal(
      siblingReleased,
      false,
      "Parallel sibling allow escaped while quarantine ancestry was resolving",
    );
    releaseLookup();
    await Promise.all([child, root, sibling]);
    assert.ok(cancelled.some((ids) => ids.includes("ses_test") && ids.includes("ses_sibling")));
    f.ctx.session.get = originalGet;
    f.sessions.ses_new_descendant = {
      ...f.sessions.ses_test,
      id: "ses_new_descendant",
      parentID: "ses_sibling",
    };
    await assertTreeChatOnly(f.hooks, [
      "ses_test",
      "ses_parent",
      "ses_grandchild",
      "ses_sibling",
      "ses_new_descendant",
    ]);
    assert.equal(f.ui.pending.length, 3, "Tree quarantine must not ask for another tool approval");
    const unrelated = modelContext("ses_unrelated");
    await f.hooks["session.context"](unrelated);
    assert.ok(unrelated.tools.read);
    const independent = f.hooks["tool.execute.before"]({
      ...input,
      sessionID: "ses_unrelated",
      id: "unrelated_allowed",
    });
    await pending(f.ui, 4);
    f.ui.pending[3].resolve("allow");
    await independent;
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const activation = decisions.filter(
      (entry) => entry.source === "plugin.user_override" && entry.scope === "session_tree",
    );
    assert.equal(activation.length, 1);
    assert.equal(activation[0].session_id, "ses_grandchild");
    assert.equal(activation[0].quarantine_root_session_id, "ses_test");
    assert.equal(f.interrupts.length, 0);
  } finally {
    releaseLookup();
    await f.cleanup();
  }
});

test("grandchild post quarantine withholds success and error while closing every root-tree tool", async () => {
  for (const status of ["completed", "error"] as const) {
    const f = await setup(undefined, new UI(), {}, nestedSessions);
    try {
      const current = { ...input, sessionID: "ses_grandchild", id: `child_${status}` };
      const before = f.hooks["tool.execute.before"](structuredClone(current));
      await pending(f.ui, 1);
      f.ui.pending[0].resolve("allow");
      await before;
      const event: any =
        status === "completed"
          ? {
              ...current,
              status,
              result: { content: "PRIVATE_CHILD_RESULT", extension: "PRIVATE_CHILD_EXTENSION" },
            }
          : {
              ...current,
              status,
              error: Object.assign(new Error("PRIVATE_CHILD_ERROR"), {
                metadata: { secret: "PRIVATE_CHILD_METADATA" },
              }),
            };
      const after = f.hooks["tool.execute.after"](event);
      await pending(f.ui, 2);
      f.ui.pending[1].resolve("quarantine");
      await after;
      assert.doesNotMatch(
        JSON.stringify(status === "completed" ? event.result : event.error),
        /PRIVATE_CHILD_/,
      );
      await assertTreeChatOnly(f.hooks, [
        "ses_test",
        "ses_parent",
        "ses_grandchild",
        "ses_sibling",
      ]);
      const unrelated = modelContext("ses_unrelated");
      await f.hooks["session.context"](unrelated);
      assert.ok(unrelated.tools.read);
      assert.equal(f.ui.pending.length, 2);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("grandchild quarantine persists the root across shared instances and restart", async () => {
  const f = await setup(undefined, new UI(), {}, nestedSessions);
  let second: Record<string, any> | undefined;
  let restarted: Record<string, any> | undefined;
  try {
    const secondContext = fixtureContext();
    nestedSessions(secondContext);
    const secondUI = new UI();
    second = await createSensor(
      secondContext.ctx,
      { stateDirectory: f.directory, apiTimeoutMs: 100 },
      { approvals: secondUI },
    );
    const heldRoot = assert.rejects(
      second["tool.execute.before"]({ ...input, id: "other_instance_root" }),
      ActionRejectedError,
    );
    await pending(secondUI, 1);
    const child = assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, sessionID: "ses_grandchild", id: "persist_tree" }),
      ActionRejectedError,
    );
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("quarantine");
    await Promise.all([child, heldRoot]);
    const markers = await Promise.all(
      (await readdir(join(f.directory, "quarantine"))).map(async (name) =>
        JSON.parse(await readFile(join(f.directory, "quarantine", name), "utf8")),
      ),
    );
    assert.deepEqual(
      markers.map((marker) => marker.session_id),
      ["ses_test"],
      "Only the confirmed root should be persisted",
    );
    await assertTreeChatOnly(second, ["ses_test", "ses_sibling", "ses_grandchild"]);
    assert.equal(secondUI.pending.length, 1);
    await second.dispose();
    await f.hooks.dispose();
    const restartContext = fixtureContext();
    nestedSessions(restartContext);
    restartContext.sessions.ses_future = {
      ...restartContext.sessions.ses_test,
      id: "ses_future",
      parentID: "ses_sibling",
    };
    const ui = new UI();
    let classifications = 0;
    restarted = await createSensor(
      restartContext.ctx,
      { stateDirectory: f.directory, apiTimeoutMs: 100 },
      {
        approvals: ui,
        classifier: async () => {
          classifications++;
          throw new Error("Classifier offline");
        },
      },
    );
    await assertTreeChatOnly(restarted, ["ses_test", "ses_parent", "ses_sibling", "ses_future"]);
    assert.equal(
      classifications,
      0,
      "Classifier fail-open must not restore a persisted quarantined tree",
    );
    assert.equal(ui.pending.length, 0);
    const other = modelContext("ses_unrelated");
    await restarted["session.context"](other);
    assert.ok(other.tools.read);
  } finally {
    await restarted?.dispose();
    await second?.dispose();
    await f.cleanup();
  }
});

test("allowing or cancelling a grandchild checkpoint never activates root quarantine", async () => {
  for (const decision of ["allow", "reject"] as const) {
    const f = await setup(undefined, new UI(), {}, nestedSessions);
    try {
      const child = f.hooks["tool.execute.before"]({
        ...input,
        sessionID: "ses_grandchild",
        id: `child_${decision}`,
      });
      const completion = decision === "reject" ? assert.rejects(child, ActionRejectedError) : child;
      await pending(f.ui, 1);
      f.ui.pending[0].resolve(decision);
      await completion;
      const store = new QuarantineStore(join(f.directory, "quarantine"));
      for (const sessionID of ["ses_test", "ses_parent", "ses_grandchild", "ses_sibling"]) {
        assert.equal(await store.isQuarantined(sessionID), false);
        const event = modelContext(sessionID);
        await f.hooks["session.context"](event);
        assert.ok(event.tools.read);
      }
      const root = f.hooks["tool.execute.before"]({ ...input, id: `root_after_${decision}` });
      await pending(f.ui, 2);
      f.ui.pending[1].resolve("allow");
      await root;
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("invalid or changed quarantine ancestry cannot persist an arbitrary root", async () => {
  const scenarios = [
    "missing",
    "wrong-id",
    "malformed-parent",
    "cycle",
    "root-parent-cycle",
    "changed-root",
    "timeout",
    "unresolved-snapshot",
  ] as const;
  for (const scenario of scenarios) {
    const f = await setup(undefined, new UI(), {}, nestedSessions);
    try {
      const originalGet = f.ctx.session.get;
      if (scenario === "unresolved-snapshot") {
        let childReads = 0;
        f.ctx.session.get = async (request: any, options: any) => {
          if (request.sessionID === "ses_grandchild" && ++childReads === 2) return undefined;
          return originalGet(request, options);
        };
      }
      const refused = assert.rejects(
        f.hooks["tool.execute.before"]({
          ...input,
          sessionID: "ses_grandchild",
          id: `invalid_${scenario}`,
        }),
        ActionRejectedError,
      );
      if (scenario === "unresolved-snapshot") {
        await refused;
        assert.equal(
          f.ui.pending.length,
          0,
          "An unresolved snapshot must not offer a root quarantine decision",
        );
        f.ctx.session.get = originalGet;
      } else {
        await pending(f.ui, 1);
        f.ctx.session.get = async (request: any, options: any) => {
          if (scenario === "root-parent-cycle" && request.sessionID === "ses_test")
            return { ...f.sessions.ses_test, parentID: "ses_grandchild" };
          if (request.sessionID === "ses_grandchild") {
            if (scenario === "missing") return undefined;
            if (scenario === "wrong-id")
              return { ...f.sessions.ses_grandchild, id: "ses_unrelated" };
            if (scenario === "malformed-parent")
              return { ...f.sessions.ses_grandchild, parentID: {} };
            if (scenario === "cycle")
              return { ...f.sessions.ses_grandchild, parentID: "ses_grandchild" };
            if (scenario === "changed-root")
              return { ...f.sessions.ses_grandchild, parentID: "ses_unrelated" };
            if (scenario === "timeout") return new Promise(() => undefined);
          }
          return originalGet(request, options);
        };
      }
      if (scenario !== "unresolved-snapshot") {
        f.ui.pending[0].resolve("quarantine");
        await refused;
      }
      f.ctx.session.get = originalGet;
      const store = new QuarantineStore(join(f.directory, "quarantine"));
      for (const sessionID of ["ses_test", "ses_unrelated", "ses_parent"])
        assert.equal(
          await store.isQuarantined(sessionID),
          false,
          `${scenario} persisted an unverified root`,
        );
      for (const sessionID of ["ses_test", "ses_unrelated"]) {
        const event = modelContext(sessionID);
        await f.hooks["session.context"](event);
        assert.ok(event.tools.read, `${scenario} latched an unverified root in memory`);
      }
      const current = modelContext("ses_grandchild");
      await f.hooks["session.context"](current);
      if (scenario !== "unresolved-snapshot")
        assert.deepEqual(
          current.tools,
          {},
          `${scenario} reopened the current session after failed resolution`,
        );
      assert.equal(f.ui.pending.length, scenario === "unresolved-snapshot" ? 0 : 1);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

async function monitorSetup(responder?: (path: string, body: any) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "sensor-monitor-"));
  const workspace = join(directory, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const f = fixtureContext();
  f.ctx.location.directory = workspace;
  f.sessions.ses_test.location.directory = workspace;
  const calls: { path: string; body: any }[] = [];
  const decision = (verdict = "ALLOW") => ({
    decision_id: "decision",
    decision: verdict,
    action_hash: "a".repeat(64),
    policy_version: "test-policy",
    reason_codes: verdict === "ALLOW" ? [] : ["P01"],
    findings: [],
    sensitive_run: false,
    approval_id: verdict === "REQUIRE_APPROVAL" ? "approval" : null,
    permit: verdict === "ALLOW" ? "permit" : null,
  });
  const client = new MonitorBackend(
    {
      url: "http://127.0.0.1:8765",
      run_id: "service-run",
      run_token: "test-run-token-123456789012345",
      workspace: await realpath(workspace),
      policy_version: "test-policy",
    },
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(options?.body));
      calls.push({ path, body });
      const custom = await responder?.(path, body);
      return Response.json(
        custom ??
          (path === "/v1/evaluate"
            ? decision()
            : path === "/v1/start"
              ? { started: true }
              : {
                  recorded: true,
                  sensitive_run: false,
                  ...(path === "/v1/events" ? { findings: [] } : {}),
                }),
      );
    },
    100,
  );
  const ui = new UI();
  ui.start = async () => {
    throw new Error("Monitor mode must not initialize native confirmation forms");
  };
  const hooks = await createSensor(
    f.ctx,
    {
      backend: "agent_monitor",
      stateDirectory: join(directory, "state"),
      openBrowser: false,
      apiTimeoutMs: 100,
      classifierTimeoutMs: 1,
    },
    {
      monitor: client,
      approvals: ui,
      classifier: async () => {
        throw new Error("Monitor mode must not invoke the stub classifier");
      },
    },
  );
  return {
    ...f,
    hooks,
    calls,
    ui,
    client,
    decision,
    directory,
    cleanup: async () => {
      await hooks.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function monitorCalls(f: Awaited<ReturnType<typeof monitorSetup>>, path: string, count = 1) {
  for (let i = 0; i < 400; i++) {
    if (f.calls.filter((c) => c.path === path).length >= count) return;
    await delay(5);
  }
  throw new Error(`Expected ${count} monitor calls to ${path}`);
}

test("monitor mode binds context and permits to service run, without local approval UI", async () => {
  const f = await monitorSetup();
  try {
    await f.registered.get("session.prompt")!({
      sessionID: "ses_test",
      prompt: { text: "Review" },
      messageID: "p",
    });
    await f.registered.get("session.context")!(modelContext());
    await f.registered.get("tool.execute.before")!(structuredClone(input));
    await f.registered.get("tool.execute.after")!(post());
    assert.deepEqual(
      f.calls.map((c) => c.path),
      ["/v1/events", "/v1/events", "/v1/evaluate", "/v1/start", "/v1/results"],
    );
    assert.deepEqual(f.calls[2].body, f.calls[3].body);
    assert.equal(f.calls[2].body.run_id, "service-run");
    assert.equal(f.calls[2].body.call_id, "msg_assistant:call_read");
    assert.equal(f.ui.pending.length, 0);
    await assert.rejects(readFile(join(f.directory, "state/control.json")), /ENOENT/);
    const files = await readdir(join(f.directory, "state/requests"));
    const snapshots = await Promise.all(
      files.map((file) =>
        readFile(join(f.directory, "state/requests", file), "utf8").then(JSON.parse),
      ),
    );
    assert.ok(
      snapshots.every(
        (r) => r.contract_version === "2.2.0" && r.enforcement.monitor_run_id === "service-run",
      ),
    );
    assert.ok(
      snapshots.every(
        (r) => r.enforcement.classifier_unavailable !== "allow_with_harness_permissions",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("monitor hard BLOCK cannot be overridden and cancels only the denied call", async () => {
  const f = await monitorSetup((path, body) =>
    path === "/v1/evaluate" && body.call_id === "msg_assistant:call_read"
      ? {
          decision_id: "d",
          decision: "BLOCK",
          action_hash: "a".repeat(64),
          policy_version: "test-policy",
          reason_codes: ["P01"],
          findings: [],
          sensitive_run: false,
          approval_id: null,
          permit: null,
        }
      : undefined,
  );
  try {
    await assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      ActionRejectedError,
    );
    assert.equal(f.ui.pending.length, 0);
    assert.ok(!f.calls.some((c) => c.path === "/v1/start"));
    const deniedResult = {
      ...structuredClone(input),
      status: "error",
      error: new Error("PRIVATE_HARNESS_ERROR"),
    };
    await f.hooks["tool.execute.after"](deniedResult);
    assert.equal(deniedResult.error.message.includes("PRIVATE_HARNESS_ERROR"), false);
    assert.match(deniedResult.error.message, /Предупреждение:/);
    assert.equal(f.client.isBroken, false);
    assert.ok(!f.calls.some((c) => c.path === "/v1/results"));
    await f.hooks["session.model.request"]({ ...modelContext(), kind: "primary", headers: {} });
    const next = { ...structuredClone(input), messageID: "msg_next", id: "call_next" };
    await f.hooks["tool.execute.before"](next);
    await f.hooks["tool.execute.after"]({ ...post(), ...next });
    assert.equal(f.calls.filter((call) => call.path === "/v1/start").length, 1);
    assert.equal(f.calls.filter((call) => call.path === "/v1/results").length, 1);
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("service approval holds the exact call and consumes permit after approval", async () => {
  let approved = false;
  const f = await monitorSetup((path) =>
    path === "/v1/evaluate"
      ? {
          decision_id: "d",
          decision: approved ? "ALLOW" : "REQUIRE_APPROVAL",
          action_hash: "a".repeat(64),
          policy_version: "test-policy",
          reason_codes: [],
          findings: [],
          sensitive_run: false,
          approval_id: approved ? null : "approval",
          permit: approved ? "permit" : null,
        }
      : undefined,
  );
  try {
    let completed = false;
    const before = f.hooks["tool.execute.before"](structuredClone(input)).then(() => {
      completed = true;
    });
    await monitorCalls(f, "/v1/evaluate");
    await delay(20);
    assert.equal(completed, false);
    assert.equal(f.ui.pending.length, 0);
    assert.ok(!f.calls.some((c) => c.path === "/v1/start"));
    approved = true;
    await before;
    const evaluations = f.calls.filter((c) => c.path === "/v1/evaluate");
    assert.ok(evaluations.length >= 2);
    assert.deepEqual(evaluations[0].body, evaluations[1].body);
    assert.deepEqual(f.calls.find((c) => c.path === "/v1/start")!.body, evaluations[0].body);
    await f.hooks["tool.execute.after"](post());
  } finally {
    await f.cleanup();
  }
});

test("cancellation aborts monitor approval waiting and never starts the tool", async () => {
  const f = await monitorSetup((path) =>
    path === "/v1/evaluate"
      ? {
          decision_id: "d",
          decision: "REQUIRE_APPROVAL",
          action_hash: "a".repeat(64),
          policy_version: "test-policy",
          reason_codes: [],
          findings: [],
          sensitive_run: false,
          approval_id: "approval",
          permit: null,
        }
      : undefined,
  );
  try {
    const before = assert.rejects(f.hooks["tool.execute.before"](structuredClone(input)));
    await monitorCalls(f, "/v1/evaluate");
    f.hooks.event({ type: "session.execution.interrupted", data: { sessionID: "ses_test" } });
    await before;
    assert.ok(!f.calls.some((c) => c.path === "/v1/start"));
    const lateResult = post();
    await f.hooks["tool.execute.after"](lateResult);
    assert.deepEqual(Object.keys(lateResult.result), ["content"]);
    assert.equal(typeof lateResult.result.content, "string");
    assert.equal(JSON.stringify(lateResult.result).includes("untrusted tool content"), false);
    assert.ok(!f.calls.some((c) => c.path === "/v1/results"));
  } finally {
    await f.cleanup();
  }
});

test("argument mutation while awaiting service approval prevents start", async () => {
  let approved = false;
  const f = await monitorSetup((path) =>
    path === "/v1/evaluate"
      ? {
          decision_id: "d",
          decision: approved ? "ALLOW" : "REQUIRE_APPROVAL",
          action_hash: "a".repeat(64),
          policy_version: "test-policy",
          reason_codes: [],
          findings: [],
          sensitive_run: false,
          approval_id: approved ? null : "approval",
          permit: approved ? "permit" : null,
        }
      : undefined,
  );
  try {
    const mutable = structuredClone(input);
    const before = assert.rejects(f.hooks["tool.execute.before"](mutable), ActionRejectedError);
    await monitorCalls(f, "/v1/evaluate");
    mutable.input.path = "/workspace/changed";
    approved = true;
    await before;
    assert.ok(!f.calls.some((c) => c.path === "/v1/start"));
  } finally {
    await f.cleanup();
  }
});

for (const failedPath of ["/v1/evaluate", "/v1/start", "/v1/results"]) {
  test(`monitor failure at ${failedPath} stops execution without classifier fail-open`, async () => {
    const f = await monitorSetup((path) => {
      if (path === failedPath) throw new Error("Offline");
    });
    try {
      if (failedPath === "/v1/results") {
        await f.hooks["tool.execute.before"](structuredClone(input));
        const output = post();
        await f.hooks["tool.execute.after"](output);
        assert.deepEqual(Object.keys(output.result), ["content"]);
        assert.equal(typeof output.result.content, "string");
        assert.match(String(output.result.content), /Предупреждение:/);
        assert.equal(JSON.stringify(output.result).includes("untrusted tool content"), false);
      } else await assert.rejects(f.hooks["tool.execute.before"](structuredClone(input)));
      await assert.rejects(f.hooks["session.model.request"]({ sessionID: "ses_test" }));
      assert.equal(f.ui.pending.length, 0);
    } finally {
      await f.cleanup();
    }
  });
}

test("monitor mode blocks attachments, subagents and unmediated shells", async () => {
  const f = await monitorSetup();
  try {
    await assert.rejects(f.hooks["shell.create.before"]({}), /shells/);
    const permission = { sessionID: "ses_test", action: "execute", effect: "allow", message: "" };
    await f.hooks["permission.evaluate"](permission);
    assert.equal(permission.effect, "deny");
    await assert.rejects(
      f.hooks["session.prompt"]({
        sessionID: "ses_test",
        prompt: { text: "Read", files: ["attachment"] },
      }),
      /attachments/,
    );
    assert.ok(!f.calls.some((c) => c.path === "/v1/evaluate"));
  } finally {
    await f.cleanup();
  }
});

test("monitor mode refuses missing credentials during startup and leaves blocking hooks", async () => {
  const f = await setup(undefined, new UI(), { backend: "agent_monitor" });
  try {
    await assert.rejects(
      f.hooks["session.model.request"]({ ...modelContext(), kind: "primary", headers: {} }),
    );
  } finally {
    await f.cleanup();
  }
});

for (const endpoint of ["/v1/start", "/v1/results"]) {
  test(`mutation during ${endpoint} cannot release a changed checkpoint`, async () => {
    const mutable = endpoint === "/v1/start" ? structuredClone(input) : post();
    const f = await monitorSetup((path) => {
      if (path === endpoint) {
        if (endpoint === "/v1/start") mutable.input.path = "/workspace/changed-during-start";
        else (mutable as ReturnType<typeof post>).result.content[0].text = "changed-during-report";
      }
    });
    try {
      if (endpoint === "/v1/results") {
        await f.hooks["tool.execute.before"](structuredClone(input));
        await f.hooks["tool.execute.after"](mutable);
        const quarantined = (mutable as ReturnType<typeof post>).result;
        assert.deepEqual(Object.keys(quarantined), ["content"]);
        assert.equal(typeof quarantined.content, "string");
        assert.match(String(quarantined.content), /Предупреждение:/);
        assert.equal(JSON.stringify(quarantined).includes("changed-during-report"), false);
      } else {
        await assert.rejects(f.hooks["tool.execute.before"](mutable), ActionRejectedError);
      }
      await assert.rejects(
        f.hooks["session.model.request"]({ ...modelContext(), kind: "primary", headers: {} }),
      );
      assert.equal(f.ui.pending.length, 0);
    } finally {
      await f.cleanup();
    }
  });
}

test("interruption while consuming a permit cannot release the tool", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await monitorSetup(async (path) => {
    if (path === "/v1/start") await held;
  });
  try {
    const before = assert.rejects(f.hooks["tool.execute.before"](structuredClone(input)));
    await monitorCalls(f, "/v1/start");
    f.hooks.event({ type: "session.execution.interrupted", data: { sessionID: "ses_test" } });
    release();
    await before;
    await assert.rejects(f.hooks["session.model.request"]({ sessionID: "ses_test" }));
  } finally {
    release();
    await f.cleanup();
  }
});

test("persisted quarantine before monitor execution blocks tools without poisoning a complete run", async () => {
  const f = await monitorSetup();
  try {
    await new QuarantineStore(join(f.directory, "state", "quarantine")).activate("ses_test");
    await assert.rejects(
      f.hooks["tool.execute.before"](structuredClone(input)),
      (error: unknown) =>
        error instanceof ActionRejectedError && error.quarantineCause === "session_quarantined",
    );
    assert.equal(f.client.isBroken, false);
    assert.equal(f.calls.length, 0, "No evaluation or permit can start after quarantine");
    assert.equal(f.ui.pending.length, 0);
    const context = modelContext();
    await f.hooks["session.context"](context);
    assert.deepEqual(context.tools, {});
    assert.equal(f.client.isBroken, false);
    assert.deepEqual(
      f.calls.map((call) => call.path),
      ["/v1/events"],
    );
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("quarantine while consuming a monitor permit cannot leave an incomplete run usable", async () => {
  let store!: QuarantineStore;
  let startAcknowledged = false;
  const f = await monitorSetup(async (path) => {
    if (path === "/v1/start") {
      await store.activate("ses_test");
      startAcknowledged = true;
    }
  });
  store = new QuarantineStore(join(f.directory, "state", "quarantine"));
  try {
    let executed = false;
    const call = f.hooks["tool.execute.before"](structuredClone(input)).then(() => {
      executed = true;
    });
    await assert.rejects(
      call,
      (error: unknown) =>
        error instanceof ActionRejectedError && error.quarantineCause === "monitor_failure",
    );
    assert.equal(startAcknowledged, true);
    assert.equal(executed, false);
    assert.equal(f.client.isBroken, true);
    assert.deepEqual(
      f.calls.map((entry) => entry.path),
      ["/v1/evaluate", "/v1/start"],
    );
    await assert.rejects(f.hooks["session.model.request"]({ ...modelContext(), kind: "primary" }));
    assert.equal(f.ui.pending.length, 0);
    assert.equal(f.interrupts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("quarantine before a monitor post report withholds results and poisons incomplete observation", async () => {
  for (const status of ["completed", "error"] as const) {
    const f = await monitorSetup();
    try {
      await f.hooks["tool.execute.before"](structuredClone(input));
      assert.equal(f.client.isBroken, false);
      await new QuarantineStore(join(f.directory, "state", "quarantine")).activate("ses_test");
      const event: any =
        status === "error"
          ? { ...structuredClone(input), status, error: new Error("PRIVATE_MONITOR_ERROR") }
          : {
              ...post(),
              result: {
                content: "PRIVATE_MONITOR_RESULT",
                metadata: { secret: "PRIVATE_METADATA" },
              },
            };
      await f.hooks["tool.execute.after"](event);
      assert.equal(f.client.isBroken, true);
      const output = status === "error" ? event.error.message : event.result.content;
      assert.match(output, /Agent Monitor недоступен или его состояние неполно/);
      assert.doesNotMatch(
        JSON.stringify(status === "error" ? event.error : event.result),
        /PRIVATE_/,
      );
      assert.equal(output.split("\n").length, 3);
      assert.ok(!f.calls.some((call) => call.path === "/v1/results"));
      await assert.rejects(
        f.hooks["session.model.request"]({ ...modelContext(), kind: "primary" }),
      );
      assert.equal(f.ui.pending.length, 0);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});
