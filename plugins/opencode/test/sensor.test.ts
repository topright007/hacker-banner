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
import { SessionBlockedError, SessionGates } from "../src/gates.js";
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

test("human rejection latches session and blocks future tools/model hooks", async () => {
  const f = await setup();
  try {
    const before = f.hooks["tool.execute.before"](input, { args });
    const rejection = assert.rejects(before, SessionBlockedError);
    await pending(f.ui, 1);
    f.ui.pending[0].resolve("reject");
    await rejection;
    await assert.rejects(
      f.hooks["tool.execute.before"]({ ...input, callID: "next" }, { args }),
      SessionBlockedError,
    );
    await assert.rejects(
      f.hooks["experimental.chat.system.transform"](
        { sessionID: input.sessionID, model: {} },
        { system: [] },
      ),
      SessionBlockedError,
    );
    assert.equal(f.ui.pending.length, 1);
    assert.ok(f.aborts.includes(input.sessionID));
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

test("confirmation UI failure remains blocked rather than using classifier fail-open", async () => {
  const ui = new UI();
  ui.ask = async () => {
    throw new Error("UI unavailable");
  };
  const f = await setup(undefined, ui);
  try {
    await assert.rejects(f.hooks["tool.execute.before"](input, { args }), SessionBlockedError);
    await assert.rejects(f.hooks["tool.execute.before"](input, { args }), SessionBlockedError);
    assert.ok(f.aborts.includes(input.sessionID));
  } finally {
    await f.cleanup();
  }
});

test("an approval cannot authorize arguments mutated while user was deciding", async () => {
  const f = await setup();
  try {
    const output = { args: { ...args } };
    const before = f.hooks["tool.execute.before"](input, output);
    const rejection = assert.rejects(before, SessionBlockedError);
    await pending(f.ui, 1);
    output.args.filePath = "/workspace/another-file";
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
    const rejection = assert.rejects(before, SessionBlockedError);
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
    await assert.rejects(f.hooks["tool.execute.before"](input, { args }), SessionBlockedError);
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

test("tree gate keeps other pending decisions; rejection applies to subsequently discovered child", async () => {
  const parents = new Map<string, string | null>([
    ["root", null],
    ["child", "root"],
    ["unrelated", null],
  ]);
  const gates = new SessionGates(parents);
  gates.hold("root", "one");
  gates.hold("child", "two");
  let released = false;
  const waiting = gates.wait("root").then(() => {
    released = true;
  });
  gates.release("one");
  await delay(5);
  assert.equal(released, false);
  await gates.wait("unrelated");
  gates.release("two");
  await waiting;
  gates.block("child");
  parents.set("new-child", "root");
  await assert.rejects(gates.wait("new-child"), SessionBlockedError);
  await gates.wait("unrelated");
  gates.close();
});
