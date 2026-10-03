import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSensor, type ApprovalUI } from "../src/sensor.js";
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
  throw new Error("Approval never appeared");
}

function fixtureClient() {
  const aborts: string[] = [];
  const response = (data: any) => async () => ({ data });
  const session = {
    id: "ses_test",
    version: "1.18.11",
    directory: "/workspace",
    permission: [],
    time: { created: 1, updated: 2 },
  };
  const messages = [
    {
      info: {
        id: "msg_user",
        sessionID: session.id,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [
        {
          id: "part_user",
          type: "text",
          text: "Read README",
          sessionID: session.id,
          messageID: "msg_user",
        },
      ],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: session.id,
        role: "assistant",
        parentID: "msg_user",
        providerID: "test",
        modelID: "test",
        agent: "build",
        time: { created: 2 },
      },
      parts: [
        {
          id: "part_read",
          type: "tool",
          tool: "read",
          callID: "call_read",
          sessionID: session.id,
          messageID: "msg_assistant",
          state: {
            status: "running",
            input: { filePath: "/workspace/README.md" },
            time: { start: 3 },
          },
        },
      ],
    },
  ];
  const client = {
    session: {
      get: response(session),
      messages: response(messages),
      children: response([]),
      status: response({ [session.id]: { type: "busy" } }),
      todo: response([]),
      diff: response([]),
      abort: async (input: any) => {
        aborts.push(input.path.id);
        return { data: true };
      },
    },
    app: { agents: response([]), log: response(true) },
    config: { get: response({}), providers: response({ providers: [] }) },
    provider: { list: response({ all: [], connected: [] }) },
    mcp: { status: response({}) },
    tool: { list: response([]), ids: response(["read"]) },
    path: { get: response({ directory: "/workspace", worktree: "/workspace" }) },
    vcs: { get: response({ branch: "main" }) },
    tui: { showToast: response(true) },
    _client: {
      get: async ({ url }: any) => ({ data: url === "/experimental/resource" ? {} : [] }),
    },
  };
  return { client, aborts };
}

async function setup(classifier?: Classifier, approvalUI: ApprovalUI = new UI()) {
  const directory = await mkdtemp(join(tmpdir(), "sensor-unit-"));
  const { client, aborts } = fixtureClient();
  const hooks = await createSensor(
    { client, project: { id: "project" }, directory: "/workspace", worktree: "/workspace" },
    { stateDirectory: directory, openBrowser: false, classifierTimeoutMs: 20, apiTimeoutMs: 100 },
    { classifier, approvals: approvalUI },
  );
  return {
    hooks,
    aborts,
    client,
    directory,
    ui: approvalUI as UI,
    cleanup: async () => {
      await hooks.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const input = { tool: "read", sessionID: "ses_test", callID: "call_read" };
const args = { filePath: "/workspace/README.md" };

function assertQuarantine(message: string, phase: "pre" | "post", reason?: string) {
  assert.match(message, /\[OpenCode Sensor\] Карантин:/);
  assert.match(message, /Инструмент: "read"/);
  assert.ok(message.includes(`Этап: ${phase === "pre" ? "до" : "после"} выполнения`));
  assert.match(message, /Причина: "/);
  if (reason) assert.ok(message.includes(`Причина: ${JSON.stringify(reason)}`));
  assert.match(message, /Сессия остаётся доступной/);
  assert.match(message, /Сообщите пользователю название инструмента, причину и итог проверки/);
}

test("default stub waits independently on pre and post; writes bound full requests", async () => {
  const f = await setup();
  try {
    let preDone = false;
    const before = f.hooks["tool.execute.before"](input, { args }).then(() => {
      preDone = true;
    });
    await pending(f.ui, 1);
    assert.equal(preDone, false);
    assert.equal(f.ui.pending[0].request.current_call.result, null);
    assert.equal(f.ui.pending[0].request.context.sessions[0].history.value.messages.length, 2);
    f.ui.pending[0].resolve("allow");
    await before;
    let postDone = false;
    const output = {
      title: "README",
      output: "untrusted tool content",
      metadata: {},
      attachments: [],
    };
    const after = f.hooks["tool.execute.after"]({ ...input, args }, output).then(() => {
      postDone = true;
    });
    await pending(f.ui, 2);
    assert.equal(postDone, false);
    assert.deepEqual(f.ui.pending[1].request.current_call.result.native, output);
    assert.notEqual(
      f.ui.pending[0].request.decision_binding.digest,
      f.ui.pending[1].request.decision_binding.digest,
    );
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

test("human rejection cancels only that tool and later model/tool requests remain available", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](input, { args });
    const rejection = assert.rejects(before, (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assertQuarantine(error.message, "pre");
      assert.match(error.message, /Тестовый карантин/);
      assert.match(error.message, /Безопасность действия не проверялась; атака не выявлялась/);
      assert.doesNotMatch(error.message, /Подозревается хакерская атака/);
      assert.match(error.message, /Пользователь отклонил/);
      assert.match(error.message, /Этот вызов инструмента не выполнен/);
      return true;
    });
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await rejection;
    await f.hooks["experimental.chat.system.transform"](
      { sessionID: input.sessionID, model: {} },
      { system: [] },
    );
    await f.hooks["chat.headers"]({ sessionID: input.sessionID }, { headers: {} });
    const next = f.hooks["tool.execute.before"]({ ...input, callID: "next" }, { args });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(decisions.every((entry) => entry.scope === "call"));
  } finally {
    await f.cleanup();
  }
});

test("post rejection scrubs builtin and MCP data in place without blocking continuation", async () => {
  const f = await setup();
  try {
    const result = {
      title: "SECRET_TITLE",
      output: "SECRET_OUTPUT",
      metadata: { secret: "SECRET_META" },
      attachments: [{ type: "file", url: "data:text/plain,SECRET_ATTACHMENT" }],
      content: [{ type: "text", text: "SECRET_MCP" }],
      structuredContent: { secret: "SECRET_STRUCTURED" },
      _meta: { secret: "SECRET_MCP_META" },
      extension: "SECRET_EXTENSION",
    };
    const original = result;
    const after = f.hooks["tool.execute.after"]({ ...input, args }, result);
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await after;
    assert.equal(result, original);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assertQuarantine(result.output, "post");
    assert.match(result.output, /Карантин: передача результата заблокирована/);
    assert.match(result.output, /Тестовый карантин/);
    assert.match(result.output, /Пользователь отклонил/);
    assert.match(result.output, /уже выполненные действия не отменены/);
    assert.deepEqual(result.metadata, {});
    assert.deepEqual(result.attachments, []);
    assert.deepEqual(result.content, [{ type: "text", text: result.output }]);
    await f.hooks["experimental.chat.system.transform"](
      { sessionID: input.sessionID },
      { system: [] },
    );
    const next = f.hooks["tool.execute.before"]({ ...input, callID: "after_post" }, { args });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("post mutation while the user approves masks the changed result", async () => {
  const f = await setup();
  try {
    const result = { title: "README", output: "original", metadata: {} };
    const after = f.hooks["tool.execute.after"]({ ...input, args }, result);
    await pending(f.ui, 1);
    result.output = "UNAPPROVED_CHANGE";
    f.ui.pending[0].resolve("allow");
    await after;
    assert.doesNotMatch(JSON.stringify(result), /UNAPPROVED_CHANGE/);
    assertQuarantine(result.output, "post");
    assert.match(result.output, /Аргументы или результат изменились/);
    assert.doesNotMatch(result.output, /Подозревается хакерская атака/);
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("classifier denial reason reaches both pre refusal and redacted post feedback", async () => {
  const reason = "Описание инструмента содержит попытку подмены инструкций.";
  const ui = new UI();
  ui.ask = async () => "reject";
  const f = await setup(
    async (request) =>
      responseFor(request, { status: "ok", decision: "deny", reason, error: null }),
    ui,
  );
  try {
    await assert.rejects(f.hooks["tool.execute.before"](input, { args }), (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assertQuarantine(error.message, "pre", reason);
      assert.match(
        error.message,
        /Подозревается хакерская атака; это предупреждение, а не подтверждённый факт/,
      );
      assert.doesNotMatch(error.message, /Тестовый карантин/);
      return true;
    });
    const result = { title: "SECRET", output: "SECRET", metadata: { secret: "SECRET" } };
    await f.hooks["tool.execute.after"]({ ...input, args }, result);
    assertQuarantine(result.output, "post", reason);
    assert.match(result.output, /Подозревается хакерская атака/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("native availability fields preserve classification and confirmation in both phases", async () => {
  const classified: ClassifierRequest[] = [];
  const confirmed: ClassifierRequest[] = [];
  const ui = new UI();
  ui.ask = async (request) => {
    confirmed.push(request);
    return "allow";
  };
  const f = await setup(async (request) => {
    classified.push(request);
    return responseFor(request, {
      status: "ok",
      decision: "deny",
      reason: "Review this checkpoint",
      error: null,
    });
  }, ui);
  try {
    const nativeData = {
      availability: "collection_error",
      nested: {
        availability: "not_observed",
        source: "untrusted-source",
        reason: "ordinary tool data",
        collected_at_ms: null,
        value: null,
      },
    };
    const toolInput = { ...input, tool: "mcp_inventory" };
    const history = (await f.client.session.messages()).data;
    const part = history[1]!.parts[0] as Record<string, any>;
    part.tool = toolInput.tool;
    part.state.input = nativeData;
    await f.hooks.event({ event: { type: "message.part.updated", properties: { part } } });
    await f.hooks["experimental.chat.messages.transform"]({}, { messages: history });

    await f.hooks["tool.execute.before"](toolInput, { args: nativeData });
    const result = {
      content: [{ type: "text", text: "Inventory response" }],
      structuredContent: nativeData,
    };
    await f.hooks["tool.execute.after"]({ ...toolInput, args: nativeData }, result);

    assert.deepEqual(
      classified.map((request) => request.phase),
      ["pre_tool_call", "post_tool_call"],
    );
    assert.equal(confirmed.length, 2);
    assert.deepEqual(classified[0]!.current_call.arguments, nativeData);
    assert.deepEqual(classified[1]!.current_call.result.native, result);
    assert.ok(classified.every((request) => request.coverage.collection_errors.length === 0));
    assert.deepEqual(f.aborts, []);
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      decisions.map((entry) => entry.decision),
      ["deny", "allow", "deny", "allow"],
    );
  } finally {
    await f.cleanup();
  }
});

test("classifier outage and timeout fail open, but never create a human approval", async () => {
  for (const classifier of [
    async () => {
      throw new Error("offline");
    },
    async () => new Promise<never>(() => {}),
  ]) {
    const f = await setup(classifier);
    try {
      await f.hooks["tool.execute.before"](input, { args });
      assert.equal(f.ui.pending.length, 0);
      const decisions = await readFile(join(f.directory, "decisions.jsonl"), "utf8");
      assert.equal(JSON.parse(decisions.trim()).decision, "unavailable");
    } finally {
      await f.cleanup();
    }
  }
});

test("confirmation UI failure cancels the action but a recovered UI can review the next call", async () => {
  const ui = new UI();
  const ask = ui.ask.bind(ui);
  ui.ask = async () => {
    throw new Error("PRIVATE_UI_DIAGNOSTIC");
  };
  const f = await setup(undefined, ui);
  try {
    await assert.rejects(f.hooks["tool.execute.before"](input, { args }), (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assertQuarantine(error.message, "pre");
      assert.match(error.message, /Подтверждение недоступно/);
      assert.match(error.message, /Тестовая заглушка классификатора отклоняет все операции/);
      assert.doesNotMatch(error.message, /PRIVATE_UI_DIAGNOSTIC|Подозревается хакерская атака/);
      return true;
    });
    await f.hooks["experimental.chat.system.transform"](
      { sessionID: input.sessionID },
      { system: [] },
    );
    ui.ask = ask;
    const next = f.hooks["tool.execute.before"](
      { ...input, callID: "after_ui_recovery" },
      { args },
    );
    await pending(ui, 1);
    ui.pending[0].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("an approval cannot authorize arguments mutated while user was deciding", async () => {
  const f = await setup();
  try {
    const output = { args: { ...args } };
    const mutableInput = { ...input };
    const before = f.hooks["tool.execute.before"](mutableInput, output);
    const rejection = assert.rejects(before, (error: unknown) => {
      assert.ok(error instanceof ActionRejectedError);
      assertQuarantine(error.message, "pre");
      assert.match(error.message, /Аргументы или результат изменились/);
      assert.doesNotMatch(error.message, /Подозревается хакерская атака|UNAPPROVED_TOOL/);
      return true;
    });
    await pending(f.ui, 1);
    output.args.filePath = "/workspace/another-file";
    mutableInput.tool = "UNAPPROVED_TOOL";
    f.ui.pending[0].resolve("allow");
    await rejection;
  } finally {
    await f.cleanup();
  }
});

test("harness cancellation during collection cannot create a late approval or release the call", async () => {
  const f = await setup();
  try {
    const get = f.client.session.get;
    let finish!: () => void;
    f.client.session.get = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return get();
    };
    const before = f.hooks["tool.execute.before"](input, { args });
    const rejection = assert.rejects(before, ActionRejectedError);
    for (let n = 0; n < 100 && !finish; n++) await delay(1);
    assert.ok(finish);
    // Harness may persist the aborted tool before announcing session idle.
    // That removes native in-flight state but must not erase an awaited hook.
    await f.hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_read",
            type: "tool",
            tool: "read",
            callID: input.callID,
            sessionID: input.sessionID,
            messageID: "msg_assistant",
            state: { status: "error", input: args, error: "Aborted", time: { start: 3, end: 4 } },
          },
        },
      },
    });
    await f.hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: input.sessionID, status: { type: "idle" } },
      },
    });
    finish();
    await rejection;
    assert.equal(f.ui.pending.length, 0);
    f.client.session.get = get;
    const next = f.hooks["tool.execute.before"]({ ...input, callID: "new_turn" }, { args });
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("normal idle in another session does not cancel the waiting checkpoint", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](input, { args });
    await pending(f.ui, 1);
    await f.hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: input.sessionID } },
      },
    });
    await f.hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "child", status: { type: "idle" } },
      },
    });
    f.ui.pending[0].resolve("allow");
    await before;
    assert.equal(f.aborts.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("wrong classifier binding is rejected and audited as unavailable", async () => {
  const f = await setup(async (req) => ({
    ...responseFor(req, { status: "ok", decision: "allow", reason: null, error: null }),
    binding_digest: "0".repeat(64),
  }));
  try {
    await f.hooks["tool.execute.before"](input, { args });
    const event = JSON.parse((await readFile(join(f.directory, "decisions.jsonl"), "utf8")).trim());
    assert.equal(event.decision, "unavailable");
  } finally {
    await f.cleanup();
  }
});

test("rejecting a parallel call leaves siblings and child-session approvals independent", async () => {
  const f = await setup();
  try {
    const first = f.hooks["tool.execute.before"](input, { args });
    const rejected = assert.rejects(first, ActionRejectedError);
    await f.hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "child", parentID: input.sessionID } },
      },
    });
    const sibling = f.hooks["tool.execute.before"]({ ...input, callID: "sibling" }, { args });
    const child = f.hooks["tool.execute.before"](
      { ...input, sessionID: "child", callID: "child_call" },
      { args },
    );
    await pending(f.ui, 3);
    const denied = f.ui.pending.find(
      (item) => item.request.current_call.hook_call_id === input.callID,
    )!;
    denied.resolve("reject");
    await rejected;
    for (const item of f.ui.pending.filter((item) => item !== denied)) item.resolve("allow");
    await Promise.all([sibling, child]);
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("native idle cancels a pending approval but the same session accepts a new action", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](input, { args });
    const rejected = assert.rejects(before, ActionRejectedError);
    await pending(f.ui, 1);
    await f.hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: input.sessionID, status: { type: "idle" } },
      },
    });
    await rejected;
    const next = f.hooks["tool.execute.before"]({ ...input, callID: "new_call" }, { args });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    const decisions = (await readFile(join(f.directory, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      decisions.filter(
        (entry) => entry.source === "plugin.user_override" && entry.decision === "deny",
      ).length,
      0,
    );
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("an aborted tool's late post is withheld without reopening approval or blocking new calls", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](input, { args });
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("allow");
    await before;
    // An abort-ignoring tool can return after OpenCode has persisted its error
    // part and announced idle; no checkpoint is executing during these events.
    await f.hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_read",
            type: "tool",
            tool: "read",
            callID: input.callID,
            sessionID: input.sessionID,
            messageID: "msg_assistant",
            state: {
              status: "error",
              input: args,
              error: "Tool execution aborted",
              metadata: { interrupted: true },
              time: { start: 3, end: 4 },
            },
          },
        },
      },
    });
    await f.hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: input.sessionID, status: { type: "idle" } },
      },
    });
    const result = { title: "Late result", output: "LATE_CANCELLED_RESULT", metadata: {} };
    const after = f.hooks["tool.execute.after"]({ ...input, args }, result);
    const completed = await Promise.race([after.then(() => true), delay(100).then(() => false)]);
    assert.equal(completed, true, "A cancelled late post must finish without a new approval");
    assert.equal(f.ui.pending.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /LATE_CANCELLED_RESULT/);
    assertQuarantine(result.output, "post");
    assert.match(result.output, /Текущая проверка отменена OpenCode/);
    assert.doesNotMatch(result.output, /Подозревается хакерская атака|Пользователь отклонил/);

    const next = f.hooks["tool.execute.before"]({ ...input, callID: "after_late_post" }, { args });
    await pending(f.ui, 2);
    f.ui.pending[1].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});

test("invalid Unicode arguments cancel just this action", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.hooks["tool.execute.before"](input, { args: { text: "\ud800" } }),
      (error: unknown) => {
        assert.ok(error instanceof ActionRejectedError);
        assertQuarantine(error.message, "pre");
        assert.match(error.message, /Внутренняя ошибка сбора контекста или проверки контракта/);
        assert.doesNotMatch(error.message, /Подозревается хакерская атака|Error:| at /);
        return true;
      },
    );
    const next = f.hooks["tool.execute.before"]({ ...input, callID: "valid" }, { args });
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("allow");
    await next;
    assert.deepEqual(f.aborts, []);
  } finally {
    await f.cleanup();
  }
});
