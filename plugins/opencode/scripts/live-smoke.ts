import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This tests plugin plumbing against the actual pinned OpenCode executable;
// the deterministic local model does not measure classifier/model quality.
type Scenario = "approve" | "reject-pre" | "reject-post";
type ToolKind = "shell" | "mcp";
type Json = Record<string, any>;
type Approval = {
  id: string;
  request_id: string;
  phase: string;
  binding_digest: string;
  session_id: string;
  tool: string;
};
type Control = { origin: string; token: string };
type ProcessState = { child: ChildProcess; exited: boolean; code: number | null; output: string };

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.OPENCODE_BIN ?? join(packageDirectory, "node_modules/.bin/opencode");
const pluginEntry = resolve(
  process.env.SENSOR_PLUGIN_ENTRY ?? join(packageDirectory, "dist/index.js"),
);
const stageTimeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function poll<T>(
  label: string,
  check: () => Promise<T | undefined>,
  processState?: ProcessState,
): Promise<T> {
  const deadline = Date.now() + stageTimeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    if (processState?.exited) {
      throw new Error(
        `OpenCode exited before ${label} (code ${processState.code}).\n${diagnostics(processState.output)}`,
      );
    }
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}.\n${diagnostics(processState?.output ?? "")}`);
}

function diagnostics(value: string): string {
  return value.replace(/(https?:\/\/127\.0\.0\.1:\d+\/#)[^\s]+/g, "$1[redacted]").slice(-8_000);
}

async function readControl(directory: string): Promise<Control | undefined> {
  try {
    const info = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
    const url = new URL(info.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.protocol, "http:");
    assert.ok(url.hash.length > 1, "Control URL must contain the private approval token");
    return { origin: url.origin, token: url.hash.slice(1) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pending(control: Control): Promise<Approval[]> {
  const response = await fetch(`${control.origin}/api/pending`, {
    headers: { Authorization: `Bearer ${control.token}` },
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { pending: Approval[] }).pending;
}

async function decide(control: Control, approval: Approval, decision: "allow" | "reject") {
  const response = await fetch(`${control.origin}/api/decision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${control.token}`,
      Origin: control.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: approval.id,
      phase: approval.phase,
      binding_digest: approval.binding_digest,
      decision,
    }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200, `Approval decision failed: ${await response.text()}`);
}

async function assertAuditContext(directory: string, approval: Approval, label: string) {
  const request = JSON.parse(
    await readFile(join(directory, "requests", `${approval.request_id}.json`), "utf8"),
  );
  assert.equal(request.contract_version, "1.1.0");
  assert.equal(request.harness.version, "1.18.11");
  assert.equal(request.request_id, approval.request_id);
  assert.equal(request.phase, approval.phase);
  assert.equal(request.decision_binding.digest, approval.binding_digest);
  const errors = request.coverage.collection_errors.map(
    (error: Json) => `${error.source}:${error.code}`,
  );
  if (errors.length) console.log(`COLLECTION ${label}: ${[...new Set(errors)].join(", ")}`);

  const call = request.current_call;
  const session = request.context.sessions.find(
    (item: Json) => item.session_id === call.session_id,
  );
  assert.ok(session, "Current session is absent from the collected context");
  assert.equal(session.history.availability, "observed");
  assert.equal(session.native_info.availability, "observed");
  assert.equal(session.native_info.value.id, call.session_id);
  const messages = session.history.value.messages;
  assert.ok(messages.length > 0, "Collected session history is empty");
  const message = messages.find((item: Json) => item.info.id === call.message_id);
  assert.ok(message, "Current call did not correlate with a real session message");
  const part = message.parts.find((item: Json) => item.id === call.part_id);
  assert.ok(part, "Current call did not correlate with a real tool part");
  assert.equal(part.type, "tool");
  assert.equal(part.tool, call.tool_name);
  assert.equal(part.callID, call.tool_call_id);
  assert.ok(call.correlation === "part.callID" || call.correlation === "part.id");
  assert.equal(call.identity.model.provider_id, "sensor-smoke");
  assert.equal(call.identity.model.model_id, "deterministic");
  assert.ok(call.identity.agent_name, "Current agent identity is absent");

  assert.equal(request.context.runtime_configuration.config_projection.availability, "observed");
  const promptContext = request.context.observed_prompt_context;
  assert.equal(promptContext.availability, "observed");
  const snapshots = promptContext.value;
  const systems = snapshots.filter(
    (item: Json) =>
      item.hook === "experimental.chat.system.transform" && item.output.system?.length > 0,
  );
  const transcripts = snapshots.filter(
    (item: Json) =>
      item.hook === "experimental.chat.messages.transform" && item.output.messages?.length > 0,
  );
  assert.ok(systems.length > 0, "Actual system hook snapshot was not collected");
  assert.ok(transcripts.length > 0, "Actual messages hook snapshot was not collected");

  const definitions = request.context.tool_catalog.definitions.value ?? [];
  const candidates = definitions.filter((item: Json) => item.tool_id === call.tool_name);
  if (candidates.length) {
    assert.ok(
      candidates.some((item: Json) => call.definition_ids.includes(item.definition_id)),
      "Current call is not linked to an observed definition candidate",
    );
  } else {
    // The pinned V1 registry hook and SDK tool.list omit direct MCP definitions.
    // Keep that coverage gap explicit; the fixture also verifies that the real
    // model receives the MCP description when selecting the requested tool.
    assert.equal(call.tool_name, "sensor_fixture_echo", "Builtin tool definition is absent");
    assert.equal(call.definition_match, "unknown");
    assert.deepEqual(call.definition_ids, []);
    console.log(`COVERAGE ${label}: direct MCP definition unavailable from V1 registry`);
  }
  console.log(
    `CONTEXT ${label}: messages=${messages.length} snapshots=${snapshots.length} ` +
      `system=${systems.length} transcripts=${transcripts.length} definitions=${definitions.length} ` +
      `currentToolCandidates=${candidates.length} collectionErrors=${errors.length}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function complete(response: ServerResponse, request: Json, message: Json, finishReason: string) {
  const common = {
    id: `chatcmpl-smoke-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
  if (request.stream) {
    const delta = { ...message };
    if (delta.tool_calls)
      delta.tool_calls = delta.tool_calls.map((call: Json, index: number) => ({ ...call, index }));
    const event = {
      ...common,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...common,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finishReason }],
      }),
    );
  }
}

async function mockModel(
  scenario: Scenario,
  marker: string,
  nextMarker: string,
  followupMarker: string,
  sentinel: string,
  toolKind: ToolKind,
) {
  const allRequests: Json[] = [];
  const primaryRequests: Json[] = [];
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(raw.length < 8 * 1024 * 1024, "Unexpectedly large model request");
      }
      const body = JSON.parse(raw);
      allRequests.push(body);
      const lastUser = body.messages.findLastIndex((item: Json) => item.role === "user");
      const followup = JSON.stringify(body.messages[lastUser]).includes("FOLLOW_UP_TURN");
      const results = body.messages
        .slice(lastUser + 1)
        .filter((item: Json) => item.role === "tool");
      const firstCall = results.length === 0;
      const callKind = followup || (!firstCall && scenario !== "approve") ? "shell" : toolKind;
      const tool = body.tools?.find((item: Json) =>
        callKind === "mcp"
          ? item.function?.description?.includes("MCP_DESCRIPTION_SENTINEL")
          : item.function?.parameters?.properties?.command,
      );
      if (!tool && body.tools?.length && callKind === "mcp")
        throw new Error("Connected MCP fixture tool is absent from the model tool catalog");
      if (!tool) {
        complete(response, body, { role: "assistant", content: "Sensor smoke test" }, "stop");
        return;
      }
      primaryRequests.push(body);
      if (firstCall || (!followup && scenario !== "approve" && results.length === 1)) {
        const command = followup
          ? `printf 'followup' > ${shellQuote(followupMarker)}; printf 'SMOKE_FOLLOWUP_RESULT'`
          : firstCall
            ? `printf 'executed' > ${shellQuote(marker)}; printf '%s' ${shellQuote(sentinel)}`
            : `printf 'independent' > ${shellQuote(nextMarker)}; printf 'SMOKE_INDEPENDENT_RESULT'`;
        complete(
          response,
          body,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: followup
                  ? "call_smoke_followup"
                  : firstCall
                    ? "call_smoke_first"
                    : "call_smoke_subsequent",
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(
                    callKind === "mcp"
                      ? { marker, text: sentinel }
                      : {
                          command,
                          description: "Local sensor smoke test",
                          timeout: 5_000,
                        },
                  ),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        complete(
          response,
          body,
          { role: "assistant", content: followup ? "SMOKE_FOLLOWUP_COMPLETE" : "SMOKE_COMPLETE" },
          "stop",
        );
      }
    } catch (error) {
      failures.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Smoke model fixture failed" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    allRequests,
    primaryRequests,
    failures,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopProcess(state: ProcessState | undefined) {
  if (!state || state.exited) return;
  state.child.kill("SIGTERM");
  for (let count = 0; count < 40 && !state.exited; count++) await pause(50);
  if (!state.exited) {
    state.child.kill("SIGKILL");
    await once(state.child, "exit");
  }
}

function startProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv): ProcessState {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const state: ProcessState = { child, exited: false, code: null, output: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      state.output = (state.output + chunk).slice(-128_000);
    });
  }
  child.on("exit", (code) => {
    state.exited = true;
    state.code = code;
  });
  child.on("error", (error) => {
    state.exited = true;
    state.output += String(error);
  });
  return state;
}

async function approveIndependentCall(
  control: Control,
  stateDirectory: string,
  state: ProcessState,
  sessionID: string,
  marker: string,
  expectedContent: string,
  callID: string,
) {
  const pre = await poll(
    `${callID} pre approval`,
    async () => (await pending(control)).find((item) => item.phase.startsWith("pre")),
    state,
  );
  assert.equal(pre.session_id, sessionID, "Independent operation moved to another session");
  const preRequest = JSON.parse(
    await readFile(join(stateDirectory, "requests", `${pre.request_id}.json`), "utf8"),
  );
  assert.equal(preRequest.current_call.tool_call_id, callID);
  await assertAuditContext(stateDirectory, pre, `${callID}/pre`);
  assert.equal(await exists(marker), false, "Independent operation ran without pre approval");
  await decide(control, pre, "allow");
  const post = await poll(
    `${callID} post approval`,
    async () => (await pending(control)).find((item) => item.phase.startsWith("post")),
    state,
  );
  assert.equal(post.session_id, sessionID);
  assert.equal(await readFile(marker, "utf8"), expectedContent);
  const postRequest = JSON.parse(
    await readFile(join(stateDirectory, "requests", `${post.request_id}.json`), "utf8"),
  );
  assert.equal(postRequest.current_call.tool_call_id, callID);
  await assertAuditContext(stateDirectory, post, `${callID}/post`);
  await decide(control, post, "allow");
}

async function runScenario(scenario: Scenario, toolKind: ToolKind = "shell") {
  if (
    process.env.SMOKE_CASES &&
    !process.env.SMOKE_CASES.split(",").includes(`${toolKind}/${scenario}`)
  )
    return;
  const temporary = await mkdtemp(join(tmpdir(), `opencode-sensor-v1-${toolKind}-${scenario}-`));
  const workdir = join(temporary, "workspace");
  const stateDirectory = join(temporary, "sensor");
  const marker = join(workdir, "first-operation.txt");
  const nextMarker = join(workdir, "subsequent-operation.txt");
  const followupMarker = join(workdir, "followup-operation.txt");
  const sentinel = `SENSOR_PRIVATE_RESULT_${scenario.replaceAll("-", "_")}`;
  await mkdir(workdir, { recursive: true });
  const model = await mockModel(scenario, marker, nextMarker, followupMarker, sentinel, toolKind);
  let processState: ProcessState | undefined;
  let serverState: ProcessState | undefined;
  const completedOutput: string[] = [];
  let passed = false;
  try {
    const configPath = join(workdir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          autoupdate: false,
          enabled_providers: ["sensor-smoke"],
          model: "sensor-smoke/deterministic",
          small_model: "sensor-smoke/deterministic",
          permission: { "*": "allow" },
          mcp:
            toolKind === "mcp"
              ? {
                  sensor_fixture: {
                    type: "local",
                    command: [process.execPath, join(packageDirectory, "scripts/mcp-fixture.mjs")],
                    enabled: true,
                  },
                }
              : {},
          plugin: [
            [
              pathToFileURL(pluginEntry).href,
              {
                stateDirectory,
                openBrowser: false,
                apiTimeoutMs: 2_000,
                classifierTimeoutMs: 3_000,
              },
            ],
          ],
          provider: {
            "sensor-smoke": {
              npm: "@ai-sdk/openai-compatible",
              name: "Local deterministic smoke fixture",
              options: { baseURL: model.baseURL, apiKey: "local-smoke-only" },
              models: {
                deterministic: {
                  name: "Deterministic",
                  limit: { context: 131_072, output: 4_096 },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const environment = {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: temporary,
      LANG: "en_US.UTF-8",
      TERM: "dumb",
      XDG_CONFIG_HOME: join(temporary, "config"),
      XDG_DATA_HOME: join(temporary, "data"),
      XDG_CACHE_HOME: join(temporary, "cache"),
      XDG_STATE_HOME: join(temporary, "state"),
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_SERVER_PASSWORD: randomBytes(24).toString("hex"),
    };
    // Both turns attach to one long-lived V1 server. A new standalone process
    // would reload the plugin and conceal a session-wide denial latch.
    const portReservation = createServer();
    portReservation.listen(0, "127.0.0.1");
    await once(portReservation, "listening");
    const address = portReservation.address();
    assert.ok(address && typeof address !== "string");
    const baseURL = `http://127.0.0.1:${address.port}`;
    await stopServer(portReservation);
    serverState = startProcess(
      ["serve", "--hostname", "127.0.0.1", "--port", String(address.port), "--print-logs"],
      workdir,
      environment,
    );
    const authorization = `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    const serverRequest = async (path: string) => {
      const response = await fetch(`${baseURL}${path}`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(response.status, 200, `OpenCode server request failed: ${path}`);
      return response.json() as Promise<Json>;
    };
    await poll(
      "persistent OpenCode server",
      async () => {
        try {
          const health = await serverRequest("/global/health");
          assert.equal(health.version, "1.18.11");
          return health.healthy === true ? true : undefined;
        } catch {
          return undefined;
        }
      },
      serverState,
    );
    if (toolKind === "mcp") {
      await poll(
        "direct MCP fixture connection",
        async () => {
          const status = await serverRequest(`/mcp?directory=${encodeURIComponent(workdir)}`);
          return status.sensor_fixture?.status === "connected" ? true : undefined;
        },
        serverState,
      );
    }
    const waitForTurn = async (sessionID: string, completion: string) => {
      await poll(
        completion,
        async () => {
          const messages = await serverRequest(
            `/session/${sessionID}/message?directory=${encodeURIComponent(workdir)}`,
          );
          assert.ok(Array.isArray(messages));
          const completed = messages.some(
            (message: Json) =>
              message.info.role === "assistant" &&
              message.info.time.completed &&
              message.parts.some(
                (part: Json) => part.type === "text" && part.text.includes(completion),
              ),
          );
          if (!completed) return undefined;
          const statuses = await serverRequest(
            `/session/status?directory=${encodeURIComponent(workdir)}`,
          );
          return !statuses[sessionID] || statuses[sessionID].type === "idle" ? true : undefined;
        },
        serverState,
      );
    };
    const runArguments = [
      "run",
      "--attach",
      baseURL,
      "--dir",
      workdir,
      "--format",
      "json",
      "--model",
      "sensor-smoke/deterministic",
    ];
    const state = (processState = startProcess(
      [...runArguments, "Run the local smoke operation, then finish."],
      workdir,
      environment,
    ));

    const control = await poll("approval server", () => readControl(stateDirectory), state);
    const pre = await poll(
      "pre approval",
      async () => (await pending(control)).find((item) => item.phase.startsWith("pre")),
      state,
    );
    assert.ok(pre.request_id && pre.binding_digest);
    assert.equal(await exists(marker), false, "Pre gate allowed the operation before approval");
    await pause(300);
    assert.equal(await exists(marker), false, "Operation ran while the pre approval was pending");

    await assertAuditContext(stateDirectory, pre, `${toolKind}/${scenario}/pre`);

    if (scenario === "reject-pre") {
      await decide(control, pre, "reject");
    } else {
      await decide(control, pre, "allow");
      const post = await poll(
        "post approval",
        async () => (await pending(control)).find((item) => item.phase.startsWith("post")),
        state,
      );
      assert.equal(await readFile(marker, "utf8"), "executed");
      assert.notEqual(post.request_id, pre.request_id, "Pre and post need separate requests");
      await assertAuditContext(stateDirectory, post, `${toolKind}/${scenario}/post`);
      if (toolKind === "mcp") {
        const request = JSON.parse(
          await readFile(join(stateDirectory, "requests", `${post.request_id}.json`), "utf8"),
        );
        assert.equal(request.current_call.result.format, "mcp_call_tool_result");
        const native = request.current_call.result.native;
        assert.equal(native.structuredContent.privateResult, sentinel);
        assert.equal(native._meta.privateResult, sentinel);
        assert.ok(
          native.content.some(
            (item: Json) => item.type === "resource" && item.resource.text === sentinel,
          ),
        );
      }
      const requestCount = model.primaryRequests.length;
      const resultRequestCount = model.allRequests.filter((request) =>
        request.messages.some((message: Json) => message.role === "tool"),
      ).length;
      await pause(300);
      assert.equal(
        model.primaryRequests.length,
        requestCount,
        "Model continued while the post approval was pending",
      );
      assert.equal(
        model.allRequests.filter((request) =>
          request.messages.some((message: Json) => message.role === "tool"),
        ).length,
        resultRequestCount,
        "Tool results reached a model request while the post approval was pending",
      );
      await decide(control, post, scenario === "approve" ? "allow" : "reject");
    }

    if (scenario !== "approve") {
      await approveIndependentCall(
        control,
        stateDirectory,
        serverState,
        pre.session_id,
        nextMarker,
        "independent",
        "call_smoke_subsequent",
      );
    }
    // V1's attached CLI can exit after a tool step. The persistent server's
    // completed assistant message and idle session are the authoritative turn result.
    await waitForTurn(pre.session_id, "SMOKE_COMPLETE");
    await poll("OpenCode completion", async () => (state.exited ? true : undefined));
    assert.equal(state.code, 0, diagnostics(state.output));
    assert.deepEqual(model.failures, [], "Mock model fixture failed");
    const forwardedToolResults = () =>
      model.allRequests.flatMap((request) =>
        request.messages.filter((message: Json) => message.role === "tool"),
      );
    const forwardedResults = forwardedToolResults();
    const resultForwarded = forwardedResults.some((message) =>
      JSON.stringify(message.content).includes(sentinel),
    );
    if (scenario === "approve") {
      assert.equal(await exists(nextMarker), false);
      assert.equal(resultForwarded, true, "Approved result never reached the model");
    } else if (scenario === "reject-pre") {
      assert.equal(await exists(marker), false, "Rejected operation created its marker");
      assert.equal(resultForwarded, false, "Rejected pre call produced a private result");
      assert.ok(
        forwardedResults.some(
          (message) =>
            message.tool_call_id === "call_smoke_first" &&
            JSON.stringify(message.content).includes("пользователь отменил это действие"),
        ),
        "Pre rejection did not become a tool error visible to the model",
      );
    } else {
      assert.equal(resultForwarded, false, "Rejected post result reached the model");
      assert.ok(
        forwardedResults.some(
          (message) =>
            message.tool_call_id === "call_smoke_first" &&
            JSON.stringify(message.content).includes(
              "Результат этого вызова скрыт: передача не разрешена",
            ),
        ),
        "Rejected post result was not replaced with the safe cancellation placeholder",
      );
      const messages = await serverRequest(
        `/session/${pre.session_id}/message?directory=${encodeURIComponent(workdir)}`,
      );
      assert.ok(
        Array.isArray(messages),
        "Session messages endpoint returned an invalid transcript",
      );
      const firstPart = messages
        .flatMap((message: Json) => message.parts)
        .find((part: Json) => part.type === "tool" && part.callID === "call_smoke_first");
      assert.ok(firstPart, "Rejected tool result is absent from the persisted session");
      // The original arguments deliberately contain the sentinel. Only released
      // result fields (including metadata/attachments), not those inputs, must be scrubbed.
      const { input: _input, ...releasedState } = firstPart.state;
      assert.equal(
        JSON.stringify({ state: releasedState, attachments: firstPart.attachments }).includes(
          sentinel,
        ),
        false,
        "Rejected result content survived in persisted output, metadata or attachments",
      );
    }
    if (scenario !== "approve") {
      assert.equal(await readFile(nextMarker, "utf8"), "independent");
      assert.ok(
        forwardedResults.some((message) =>
          JSON.stringify(message.content).includes("SMOKE_INDEPENDENT_RESULT"),
        ),
        "Approved independent result never reached the model",
      );
      assert.ok(
        serverState && !serverState.exited,
        "Persistent server stopped before the next turn",
      );
      completedOutput.push(state.output);
      const followupState = (processState = startProcess(
        [
          ...runArguments,
          "--session",
          pre.session_id,
          "Run the follow-up smoke operation in this same session, then finish. FOLLOW_UP_TURN",
        ],
        workdir,
        environment,
      ));
      await approveIndependentCall(
        control,
        stateDirectory,
        serverState,
        pre.session_id,
        followupMarker,
        "followup",
        "call_smoke_followup",
      );
      await waitForTurn(pre.session_id, "SMOKE_FOLLOWUP_COMPLETE");
      await poll("same-session follow-up completion", async () =>
        followupState.exited ? true : undefined,
      );
      assert.equal(followupState.code, 0, diagnostics(followupState.output));
      assert.equal(await readFile(followupMarker, "utf8"), "followup");
      assert.deepEqual(
        await readControl(stateDirectory),
        control,
        "Sensor control changed between turns; plugin may have reloaded",
      );
      assert.deepEqual(model.failures, []);
      assert.equal(
        forwardedToolResults().some((message) =>
          JSON.stringify(message.content).includes(sentinel),
        ),
        false,
        "Rejected private result resurfaced in the next user turn",
      );
      assert.ok(
        forwardedToolResults().some((message) =>
          JSON.stringify(message.content).includes("SMOKE_FOLLOWUP_RESULT"),
        ),
        "Approved follow-up result never reached the model",
      );
    }
    passed = true;
    console.log(
      `PASS ${toolKind}/${scenario}: ${model.primaryRequests.length} primary model request(s)`,
    );
  } catch (error) {
    await writeFile(
      join(temporary, "opencode.log"),
      diagnostics(
        [...completedOutput, processState?.output ?? "", serverState?.output ?? ""].join("\n"),
      ),
    );
    await writeFile(
      join(temporary, "cli.log"),
      diagnostics([...completedOutput, processState?.output ?? ""].join("\n")),
    );
    await writeFile(
      join(temporary, "model-requests.json"),
      JSON.stringify(model.allRequests, null, 2),
    );
    console.error(`Smoke artifacts retained at ${temporary}`);
    throw error;
  } finally {
    await stopProcess(processState);
    await stopProcess(serverState);
    await stopServer(model.server);
    if (passed && process.env.KEEP_SMOKE_ARTIFACTS !== "1")
      await rm(temporary, { recursive: true, force: true });
    else if (passed) console.log(`Smoke artifacts retained at ${temporary}`);
  }
}

await access(pluginEntry);
await access(executable);
const version = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
});
assert.equal(version.status, 0, version.stderr);
assert.match(
  version.stdout.trim(),
  /^1\.18\.11(?:\s|$)/,
  "Live smoke requires the pinned OpenCode 1.18.11",
);
for (const toolKind of ["shell", "mcp"] as const)
  for (const scenario of ["approve", "reject-pre", "reject-post"] as const)
    await runScenario(scenario, toolKind);
