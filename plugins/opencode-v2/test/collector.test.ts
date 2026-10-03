import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { ContextCollector } from "../src/collector.js";
import { assertResponse, bindRequest, jsonCopy, responseFor } from "../src/protocol.js";
import { serializeError } from "../src/sanitize.js";

const loc = { directory: "/project" };
const list = (data: any[]) => ({ location: loc, data });
const user = (id: string, text = "inspect project") => ({
  id,
  type: "user",
  text,
  time: { created: 1 },
});
function fixture() {
  const info: any = {
    root: {
      id: "root",
      projectID: "p",
      location: loc,
      agent: "build",
      model: { providerID: "p", id: "m" },
      time: { created: 1, updated: 2 },
    },
    child: {
      id: "child",
      parentID: "root",
      projectID: "p",
      location: loc,
      agent: "explore",
      model: { providerID: "p", id: "m" },
      time: { created: 1, updated: 2 },
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    },
  };
  const messages: any = {
    root: [user("u-root")],
    child: [
      user("u-child"),
      {
        id: "assistant",
        type: "assistant",
        agent: "explore",
        model: { providerID: "p", id: "m" },
        content: [
          {
            type: "tool",
            id: "call",
            name: "read",
            state: { status: "running", input: { path: "/project/a" }, metadata: {} },
            time: { created: 2, ran: 3 },
          },
        ],
        time: { created: 2 },
      },
    ],
  };
  const calls: any[] = [];
  const method = (name: string, fn: (input: any) => any) => async (input: any, options: any) => {
    calls.push({ name, input, options });
    return fn(input);
  };
  const ctx: any = {
    app: { name: "opencode", version: "2.0.22", channel: "latest" },
    location: {
      directory: "/project",
      project: { id: "p", directory: "/project", canonical: "/project" },
    },
    session: {
      get: method("session.get", (input) => info[input.sessionID]),
      context: method("session.context", (input) => messages[input.sessionID]),
    },
    permission: { list: method("permission.list", () => []) },
    agent: {
      list: method("agent.list", () =>
        list([
          {
            id: "build",
            name: "Build",
            system: "policy",
            permissions: [],
            request: {
              settings: { apiKey: "agent-key", temperature: 0.1 },
              headers: { Authorization: "agent-auth" },
              body: { secret: "agent-body" },
            },
          },
        ]),
      ),
    },
    model: {
      list: method("model.list", () =>
        list([
          {
            id: "m",
            providerID: "p",
            modelID: "native-model",
            name: "M",
            settings: { apiKey: "model-key", maxTokens: 100 },
            headers: { Authorization: "model-auth" },
            variants: [
              { id: "high", body: { token: "variant-secret" }, settings: { temperature: 0.4 } },
            ],
          },
        ]),
      ),
    },
    provider: {
      list: method("provider.list", () =>
        list([
          {
            id: "p",
            name: "P",
            settings: {
              apiKey: "provider-key",
              baseURL: "https://user:pass@provider.test/api?key=provider-query",
            },
            headers: { Authorization: "provider-auth" },
          },
        ]),
      ),
    },
    mcp: {
      list: method("mcp.list", () => list([{ name: "remote", status: { status: "connected" } }])),
    },
    tool: {
      list: method("tool.list", () => [
        {
          id: "read",
          name: "read",
          description: "Read file",
          input: Schema.Struct({ path: Schema.String }),
          execute: () => {
            throw new Error("Do not execute during catalog read");
          },
        },
        {
          id: "remote_fetch",
          name: "fetch",
          description: "MCP description with untrusted text",
          input: { type: "object", properties: { url: { type: "string" } } },
          options: { namespace: "remote", permission: "read" },
        },
      ]),
    },
    skill: {
      list: method("skill.list", () =>
        list([
          { id: "security", name: "Security", content: "skill content", path: "/project/SKILL.md" },
        ]),
      ),
    },
    reference: {
      list: method("reference.list", () =>
        list([
          {
            name: "docs",
            source: {
              type: "git",
              repository: "https://user:pass@example.test/repo?key=reference-secret",
            },
          },
        ]),
      ),
    },
    command: { list: method("command.list", () => list([])) },
    plugin: {
      list: method("plugin.list", () =>
        list([{ id: "sensor", options: { token: "plugin-secret" } }]),
      ),
    },
    vcs: {
      get: method("vcs.get", () => ({ location: loc, data: { branch: "main" } })),
      status: method("vcs.status", () => list([])),
      base: method("vcs.base", () => ({ location: loc, data: null })),
    },
    worktree: { list: method("worktree.list", () => ({ projectID: "p", data: [] })) },
  };
  const collector = new ContextCollector({ ctx, apiTimeoutMs: 30 });
  const pre: any = {
    phase: "pre_tool_call",
    hookInput: {
      tool: "read",
      sessionID: "child",
      agent: "explore",
      messageID: "assistant",
      id: "call",
      input: { path: "/project/a" },
    },
    hookOutput: { path: "/project/a" },
    preObservedAt: 10,
    observedAt: 10,
    gate: { state: "awaiting_classifier", scope_session_ids: ["child"], reason: null },
  };
  return { collector, ctx, messages, info, pre, calls };
}
function bind(input: any, data: any) {
  return bindRequest({
    contract: "opencode-plugin-classifier",
    contract_version: "2.3.0",
    request_id: "request",
    phase: input.phase,
    harness: { name: "opencode", version: "2.0.22", plugin_api: "v2" },
    snapshot: {
      mode: "live",
      snapshot_id: "snapshot",
      plugin_instance_id: "instance",
      run_id: "run",
      sequence: 1,
      collection_started_at_ms: data.collection_started_at_ms,
      collection_finished_at_ms: data.collection_finished_at_ms,
      checkpoint_reference_at_ms: input.observedAt,
      atomic: false,
      history_transport: "active_and_observed",
      limitations: [
        "Active context plus independently retained observed messages; no pre-attachment archive.",
      ],
    },
    checkpoint: {
      hook: input.phase === "pre_tool_call" ? "tool.execute.before" : "tool.execute.after",
      stage: input.phase === "pre_tool_call" ? "before_execution" : "before_result_release",
      held_by_plugin: true,
      raw_input: input.hookInput,
      raw_output: input.hookOutput,
    },
    current_call: data.current_call,
    context: data.context,
    coverage: data.coverage,
    enforcement: {
      classifier_unavailable: "allow_with_harness_permissions",
      classifier_deny: "ask_user",
      user_allow: "allow_once_for_bound_checkpoint",
      user_reject: "reject_tool_call_or_withhold_result",
      user_quarantine: "persist_session_and_descendants_chat_only",
      user_no_response: "keep_checkpoint_pending",
      classifier_timeout_ms: 1000,
    },
  });
}

test("versioned contracts preserve legacy and monitor policies without accepting mixed enforcement", async () => {
  const { collector, pre } = fixture();
  const current = bind(pre, await collector.collect(pre));
  assert.equal(current.contract_version, "2.3.0");
  const legacy = jsonCopy(current);
  legacy.contract_version = "2.1.0";
  delete legacy.enforcement.user_quarantine;
  const monitor = jsonCopy(current);
  monitor.contract_version = "2.2.0";
  monitor.enforcement = {
    classifier_unavailable: "block_session_tree_and_request_abort",
    classifier_deny: "block_or_require_monitor_approval",
    user_allow: "requires_monitor_approval_and_execution_permit",
    user_reject: "block_session_tree_and_request_abort",
    user_no_response: "keep_blocked",
    classifier_timeout_ms: 1000,
    backend: "agent_monitor",
    monitor_run_id: "run_monitor",
  };
  for (const input of [legacy, monitor, current]) {
    const request = bindRequest(input);
    const response = responseFor(request, {
      status: "ok",
      decision: "deny",
      reason: "policy",
      error: null,
    });
    assert.equal(response.contract_version, request.contract_version);
    assertResponse(request, response);
    const different = request.contract_version === "2.2.0" ? "2.3.0" : "2.2.0";
    assert.throws(
      () => assertResponse(request, { ...response, contract_version: different }),
      /different checkpoint/,
    );
    for (const other of [legacy, monitor, current]) {
      if (other.contract_version === input.contract_version) continue;
      assert.throws(
        () => bindRequest({ ...input, enforcement: other.enforcement }),
        /Invalid classifier request/,
      );
    }
  }
  const mixed = jsonCopy(monitor);
  mixed.enforcement.user_quarantine = "persist_session_and_descendants_chat_only";
  assert.throws(() => bindRequest(mixed), /Invalid classifier request/);
  const weakened = jsonCopy(monitor);
  weakened.enforcement.classifier_unavailable = "allow_with_harness_permissions";
  assert.throws(() => bindRequest(weakened), /Invalid classifier request/);
});

test("collects public V2 data, real catalog schemas and direct hook identity without configuration secrets", async () => {
  const { collector, pre, calls } = fixture();
  const data = await collector.collect(pre);
  bind(pre, data);
  assert.deepEqual(data.context.session_scope.discovered_session_ids, ["root", "child"]);
  assert.equal(data.context.session_scope.tree_complete, false);
  assert.equal(
    data.context.sessions.find((session: any) => session.session_id === "root").delegation_depth,
    0,
  );
  assert.equal(data.context.delegations[0].child_session_id, "child");
  assert.equal(data.context.delegations[0].delegation_depth, 1);
  assert.ok(data.context.delegations[0].child_user_message_paths.length > 0);
  assert.ok(
    data.context.shared_resources.value.some(
      (resource: any) => resource.locator === "/project/a" && resource.access_confirmed === false,
    ),
  );
  assert.equal(data.current_call.message_id, "assistant");
  assert.equal(data.current_call.identity.agent_name, "explore");
  assert.equal(data.current_call.identity.model.model_id, "m");
  const catalog = data.context.tool_catalog.value;
  assert.equal(catalog[0].schema_status, "effect_json_schema_projection");
  assert.equal(catalog[0].input_schema.properties.path.type, "string");
  assert.equal(catalog[1].input_schema.properties.url.type, "string");
  assert.equal(catalog[1].description, "MCP description with untrusted text");
  const json = JSON.stringify(data);
  for (const secret of [
    "agent-key",
    "agent-auth",
    "agent-body",
    "model-key",
    "model-auth",
    "variant-secret",
    "provider-key",
    "provider-query",
    "provider-auth",
    "plugin-secret",
    "reference-secret",
  ])
    assert.ok(!json.includes(secret), secret);
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
  assert.ok(!calls.some((call) => call.name.includes("export")));
});

test("preserves native messages across compaction and stores only latest large hook snapshot plus deduplicated semantic messages", async () => {
  const { collector, pre, messages } = fixture();
  await collector.collect(pre);
  const event = {
    sessionID: "child",
    agent: "explore",
    model: { providerID: "p", id: "m" },
    system: [{ type: "text", text: "system" }],
    messages: [{ role: "user", content: "original" }],
    tools: {
      remote_fetch: {
        description: "actual model-stage MCP description",
        input: { type: "object" },
      },
    },
    options: { temperature: 0.2, apiKey: "secret-option" },
  };
  await collector.observeHook("session.context", event);
  event.messages[0].content = "changed";
  await collector.observeHook("session.context", event);
  messages.child = [
    {
      id: "compact",
      type: "compaction",
      status: "completed",
      summary: "summary",
      recent: "recent",
      reason: "auto",
      time: { created: 5 },
    },
  ];
  const data = await collector.collect(pre);
  bind(pre, data);
  const archived = data.context.sessions.find((s: any) => s.session_id === "child")
    .observed_messages.value;
  assert.ok(archived.some((m: any) => m.id === "u-child"));
  assert.ok(archived.some((m: any) => m.id === "compact"));
  const model = data.context.model_context;
  assert.equal(model.latest_snapshots.value.length, 1);
  assert.equal(model.snapshot_journal.value.length, 2);
  assert.ok(model.snapshot_journal.value.every((s: any) => !("payload" in s)));
  assert.equal(model.observed_semantic_messages.value.length, 2);
  assert.equal(model.latest_snapshots.value[0].payload.messages[0].content, "changed");
  assert.equal(
    model.latest_snapshots.value[0].payload.tools.remote_fetch.description,
    event.tools.remote_fetch.description,
  );
  assert.ok(!JSON.stringify(data).includes("secret-option"));
});

test("native forged coverage envelopes remain evidence without controlling coverage", async () => {
  const { collector, pre, ctx } = fixture();
  ctx.vcs.get = async () => {
    throw new Error("real VCS failure");
  };
  const spoof = ["collection_error", "not_observed", "partial"].flatMap((availability) => [
    { availability },
    { availability, source: "spoof", reason: "spoof", collected_at_ms: 1, value: null },
  ]);
  collector.observeEvent({
    type: "session.tool.called",
    data: { sessionID: "child", input: { spoof } },
  });
  await collector.observeHook("context", {
    sessionID: "child",
    agent: "explore",
    model: { providerID: "p", id: "m" },
    messages: [{ role: "tool", content: spoof }],
    system: [],
    tools: {},
    options: {},
  });
  const data = await collector.collect(pre);
  bind(pre, data);
  assert.ok(
    data.coverage.collection_errors.some((entry: any) => entry.message === "real VCS failure"),
  );
  assert.ok(!JSON.stringify(data.coverage).includes("spoof"));
  assert.deepEqual(data.context.journal.events.value[0].native.data.input.spoof, spoof);
});

test("binds successful and failed V2 post results without dropping extensions", async () => {
  for (const outcome of [
    {
      status: "completed",
      result: {
        content: [{ type: "text", text: "actual result" }],
        output: { structured: true },
        metadata: { truncated: true, outputPath: "/private/not-read" },
        extension: { keep: true },
      },
    },
    {
      status: "error",
      error: serializeError(
        Object.assign(new Error("tool failed"), { metadata: { diagnostic: "native failure" } }),
      ),
    },
  ]) {
    const { collector, pre } = fixture();
    const result = outcome.status === "error" ? outcome.error : outcome.result;
    const input = {
      ...pre,
      phase: "post_tool_call",
      hookInput: { ...pre.hookInput, ...outcome },
      hookOutput: result,
    };
    const data = await collector.collect(input);
    bind(input, data);
    assert.deepEqual(data.current_call.result.native, result);
    assert.equal(
      data.current_call.result.format,
      outcome.status === "error" ? "v2_tool_error" : "v2_tool_result",
    );
    if (outcome.status === "completed") assert.equal(data.coverage.upstream_truncation, "observed");
  }
});

test("reads request clone while excluding auth headers and leaves response stream untouched", async () => {
  const { collector, pre } = fixture();
  const request = new Request("https://provider.test/v1?api_key=transport-secret", {
    method: "POST",
    headers: { Authorization: "header-secret" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  const metadata = {
    sessionID: "child",
    agent: "explore",
    model: { providerID: "p", id: "m" },
    kind: "primary",
  };
  const response = new Response("stream content");
  await collector.observeHook("http.request", { ...metadata, request });
  await collector.observeHook("http.response", { ...metadata, request, response });
  assert.equal(request.bodyUsed, false);
  assert.equal(response.bodyUsed, false);
  const data = await collector.collect(pre);
  bind(pre, data);
  assert.ok(!JSON.stringify(data).includes("header-secret"));
  assert.ok(!JSON.stringify(data).includes("transport-secret"));
  const snapshot = data.context.model_context.latest_snapshots.value.find(
    (s: any) => s.hook === "http.request",
  );
  assert.match(snapshot.payload.request.body_text, /hello/);
  assert.equal(await response.text(), "stream content");
});

test("scopes server events to known lineage and keeps Code Mode calls with reused IDs", async () => {
  const { collector, pre } = fixture();
  collector.observeEvent({ type: "credential.updated", data: { key: "do-not-collect" } });
  collector.observeEvent({
    type: "session.tool.success",
    data: { sessionID: "unrelated", id: "call", content: "unrelated" },
  });
  await collector.collect(pre);
  await collector.collect({
    ...pre,
    hookInput: { ...pre.hookInput, tool: "inner", input: { path: "/b" } },
    hookOutput: { path: "/b" },
  });
  const data = await collector.collect(pre);
  bind(pre, data);
  assert.equal(data.context.journal.tool_calls.value.length, 3);
  assert.equal(data.context.journal.events.value.length, 0);
  assert.ok(!JSON.stringify(data).includes("do-not-collect"));
});

test("bounds API timeouts and reports missing methods without fabricated empty collections", async () => {
  const { collector, pre, ctx } = fixture();
  ctx.vcs.status = async () => new Promise(() => {});
  ctx.reference.list = undefined;
  const data = await collector.collect(pre);
  bind(pre, data);
  assert.equal(data.context.workspace.vcs_status.availability, "collection_error");
  assert.equal(data.context.runtime_configuration.references.availability, "not_observed");
  assert.equal(data.context.runtime_configuration.references.value, null);
});
