import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

class UI implements ApprovalUI {
  pending: { request: ClassifierRequest; resolve: (decision: "allow" | "reject") => void }[] = [];
  async start() {}
  async ask(
    request: ClassifierRequest,
    _response: ClassifierResponse,
  ): Promise<"allow" | "reject"> {
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
  system: ["System"],
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
    assert.equal(first.contract_version, "2.1.0");
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

test("human pre rejection cancels only that call and later model/tool requests work", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](structuredClone(input));
    const rejected = assert.rejects(before, (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assert.match(error.message, /Карантин: действие заблокировано/);
      assert.match(error.message, /Инструмент: "read"/);
      assert.match(error.message, /Этап: до выполнения/);
      assert.match(error.message, /Причина: "Тестовая заглушка классификатора/);
      assert.match(error.message, /Тестовый карантин/);
      assert.match(error.message, /Безопасность действия не проверялась/);
      assert.match(error.message, /Этот вызов инструмента не выполнен/);
      assert.match(error.message, /Пользователь отклонил разовое разрешение/);
      assert.match(error.message, /Сессия остаётся доступной/);
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
    assert.match(String(event.result.content), /Карантин: передача результата заблокирована/);
    assert.match(String(event.result.content), /Инструмент: "read"/);
    assert.match(String(event.result.content), /Этап: после выполнения/);
    assert.match(String(event.result.content), /Причина: "Тестовая заглушка классификатора/);
    assert.match(String(event.result.content), /уже выполненные действия не отменены/);
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
    assert.match(event.error.message, /Карантин: передача ошибки заблокирована/);
    assert.match(event.error.message, /Инструмент: "read"/);
    assert.match(event.error.message, /Этап: после выполнения/);
    assert.match(event.error.message, /Причина: "Тестовая заглушка классификатора/);
    assert.match(event.error.message, /Передача ошибки отклонена/);
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
      assert.match(
        message,
        /Подозревается хакерская атака; это предупреждение, а не подтверждённый факт/,
      );
      assert.match(message, /Сообщите пользователю название инструмента, причину и итог проверки/);
      assert.match(message, /Сессия остаётся доступной/);
      assert.doesNotMatch(message, /RAW_PRIVATE|Тестовый карантин/);
      assert.equal(f.interrupts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("post confirmation failure preserves classifier reason without exposing diagnostics", async () => {
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
    assert.match(event.result.content, /Карантин: передача результата заблокирована/);
    assert.match(event.result.content, /Причина: "Непроверенный внешний источник"/);
    assert.match(event.result.content, /Подтверждение недоступно/);
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
    assert.match(String(event.result.content), /Карантин: передача результата заблокирована/);
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
