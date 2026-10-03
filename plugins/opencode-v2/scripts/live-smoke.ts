import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

// This tests the actual pinned OpenCode server through its native client APIs.
// Noninteractive `opencode run` cancels native forms, so it cannot drive these approvals.
// The deterministic local model does not measure classifier/model quality or UI rendering.
type Scenario = "approve" | "reject-pre" | "reject-post" | "cancel-pre";
type ToolKind = "shell" | "mcp" | "read-error" | "none";
type Json = Record<string, any>;
type Approval = {
  id: string;
  request_id: string;
  phase: string;
  binding_digest: string;
  session_id: string;
  tool: string;
};
type NativeClient = ReturnType<typeof OpenCode.make>;
type ProcessState = { child: ChildProcess; exited: boolean; code: number | null; output: string };

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.OPENCODE_BIN ?? join(packageDirectory, "node_modules/.bin/opencode");
const pluginPackage = resolve(process.env.SENSOR_PLUGIN_PACKAGE ?? packageDirectory);
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

async function pending(client: NativeClient, directory: string): Promise<Approval[]> {
  const { data: forms } = await client.form.list(
    { location: { directory } },
    { signal: AbortSignal.timeout(2_000) },
  );
  const result: Approval[] = [];
  for (const form of forms.filter((item) => item.metadata?.sensor === "opencode-sensor-v2")) {
    const detail = await client.session.form.get(
      { sessionID: form.sessionID, formID: form.id },
      { signal: AbortSignal.timeout(2_000) },
    );
    if (detail.state.status !== "pending") continue;
    const metadata = detail.metadata!;
    assert.equal(metadata.kind, "question", "Desktop requires the native question form kind");
    assert.equal(metadata.session_id, form.sessionID);
    assert.equal(typeof metadata.request_id, "string");
    assert.equal(typeof metadata.phase, "string");
    assert.equal(typeof metadata.binding_digest, "string");
    assert.equal(typeof metadata.tool, "string");
    assert.ok(detail.title.includes("Карантин"));
    assert.equal(detail.fields.length, 1);
    const field = detail.fields[0];
    assert.equal(field.key, "decision");
    assert.ok(field.title?.includes("Карантин"));
    assert.ok(field.title?.includes(metadata.tool as string));
    assert.equal(field.type, "string");
    assert.equal(field.required, true);
    assert.equal("default" in field, false, "Native approval must not have a default answer");
    assert.ok(field.type === "string" && field.custom === false);
    assert.deepEqual(
      field.options?.map((option) => option.value),
      ["reject", "allow"],
    );
    assert.ok(field.description?.includes("Тестовая заглушка классификатора"));
    result.push({
      id: form.id,
      request_id: metadata.request_id as string,
      phase: metadata.phase as string,
      binding_digest: metadata.binding_digest as string,
      session_id: form.sessionID,
      tool: metadata.tool as string,
    });
  }
  return result;
}

async function decide(
  client: NativeClient,
  approval: Approval,
  decision: "allow" | "reject" | "cancel",
) {
  const input = { sessionID: approval.session_id, formID: approval.id };
  if (decision === "cancel") {
    await client.session.form.cancel(input, { signal: AbortSignal.timeout(2_000) });
  } else {
    await client.session.form.reply(
      { ...input, answer: { decision } },
      { signal: AbortSignal.timeout(2_000) },
    );
  }
  const detail = await client.session.form.get(input, { signal: AbortSignal.timeout(2_000) });
  assert.equal(detail.state.status, decision === "cancel" ? "cancelled" : "answered");
  if (detail.state.status === "answered") assert.deepEqual(detail.state.answer, { decision });
}

function assertQuarantineFeedback(
  messages: Json[],
  tool: string,
  phase: "pre" | "post",
  errorOutcome = false,
) {
  const result = messages.find((message) => message.tool_call_id === "call_smoke_first");
  assert.ok(result, "Quarantined call feedback never reached the model");
  let feedback =
    typeof result.content === "string"
      ? result.content
      : result.content.map((part: Json) => part.text ?? "").join("\n");
  try {
    const envelope = JSON.parse(feedback) as Json;
    if (typeof envelope.error?.message === "string") feedback = envelope.error.message;
  } catch {
    // A regular tool result is already plain text; native errors may use a JSON envelope.
  }
  assert.ok(
    feedback.includes(
      phase === "pre"
        ? "[OpenCode Sensor] Карантин: действие заблокировано."
        : errorOutcome
          ? "[OpenCode Sensor] Карантин: передача ошибки заблокирована."
          : "[OpenCode Sensor] Карантин: передача результата заблокирована.",
    ),
    "Model-bound quarantine feedback lost its action-specific status",
  );
  assert.ok(feedback.includes(`Инструмент: ${JSON.stringify(tool)}`));
  assert.ok(feedback.includes(`Этап: ${phase === "pre" ? "до выполнения" : "после выполнения"}`));
  assert.match(feedback, /Причина:.*Тестовая заглушка классификатора отклоняет все операции/);
  assert.ok(feedback.includes("Безопасность этого действия не проверялась."));
  assert.ok(feedback.includes("Тестовый карантин"), "Stub denial was presented as a real attack");
  assert.ok(feedback.includes("Сессия остаётся доступной."));
  assert.ok(feedback.includes("Не повторяйте это действие без нового разрешения пользователя."));
}

async function assertAuditContext(directory: string, approval: Approval, label: string) {
  const request = JSON.parse(
    await readFile(join(directory, "requests", `${approval.request_id}.json`), "utf8"),
  );
  assert.equal(request.request_id, approval.request_id);
  assert.equal(request.phase, approval.phase);
  assert.equal(request.decision_binding.digest, approval.binding_digest);
  assert.equal(request.contract_version, "2.1.0");
  assert.equal(request.harness.version, "2.0.22");
  const call = request.current_call;
  assert.ok(call.tool_call_id);
  assert.ok(call.message_id);
  assert.equal(request.checkpoint.raw_input.id, call.tool_call_id);
  assert.equal(request.checkpoint.raw_input.input.command, call.arguments.command);
  const serialized = JSON.stringify(request.context);
  const snapshots = request.context.model_context.latest_snapshots.value;
  assert.ok(
    snapshots.some(
      (item: Json) =>
        item.hook === "context" && item.payload.system.length && item.payload.messages.length,
    ),
    "Semantic context hook not observed",
  );
  assert.equal(request.context.tool_catalog.availability, "observed");
  assert.ok(
    request.context.tool_catalog.value.some(
      (item: Json) => item.tool_id === call.tool_name && typeof item.description === "string",
    ),
    "Current tool description missing",
  );
  if (call.arguments.marker)
    assert.ok(serialized.includes("MCP_DESCRIPTION_SENTINEL"), "MCP description not collected");
  assert.ok(serialized.includes("sensor-smoke"), "Provider identity not collected");
  assert.ok(serialized.includes("deterministic"), "Model identity not collected");
  assert.ok(serialized.includes("Run the local smoke operation"), "Prompt not collected");
  assert.ok(serialized.includes("description"), "Tool descriptions not collected");
  console.log(`CONTEXT ${label}: bytes=${Buffer.byteLength(serialized)}`);
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
      if (toolKind === "none") {
        if (body.tools?.length) primaryRequests.push(body);
        complete(response, body, { role: "assistant", content: "SMOKE_COMPLETE" }, "stop");
        return;
      }
      const lastUser = body.messages.findLastIndex((item: Json) => item.role === "user");
      const followup = JSON.stringify(body.messages[lastUser]).includes("FOLLOW_UP_TURN");
      const results = body.messages
        .slice(lastUser + 1)
        .filter(
          (item: Json) => item.role === "tool" && !item.tool_call_id?.startsWith("call_warmup"),
        );
      const firstCall = results.length === 0;
      const callKind = followup || (!firstCall && scenario !== "approve") ? "shell" : toolKind;
      const tool = body.tools?.find((item: Json) =>
        callKind === "read-error"
          ? item.function?.name === "read"
          : callKind === "mcp"
            ? item.function?.description?.includes("MCP_DESCRIPTION_SENTINEL")
            : item.function?.parameters?.properties?.command,
      );
      if (
        !tool &&
        callKind === "mcp" &&
        body.tools?.some((item: Json) => item.function.name === "shell")
      ) {
        const warmups = body.messages.filter((item: Json) =>
          item.tool_call_id?.startsWith("call_warmup"),
        );
        assert.ok(warmups.length < 5, "MCP tool never became available");
        await pause(150);
        complete(
          response,
          body,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_warmup_${warmups.length}`,
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({
                    command: "true",
                    description: "Wait for local MCP fixture connection",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
        return;
      }
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
                    callKind === "read-error"
                      ? { path: join(dirname(marker), sentinel) }
                      : callKind === "mcp"
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
  client: NativeClient,
  workdir: string,
  stateDirectory: string,
  state: ProcessState,
  sessionID: string,
  marker: string,
  expectedContent: string,
  callID: string,
) {
  const pre = await poll(
    `${callID} pre approval`,
    async () => (await pending(client, workdir)).find((item) => item.phase.startsWith("pre")),
    state,
  );
  assert.equal(pre.session_id, sessionID, "Independent operation moved to another session");
  const preRequest = JSON.parse(
    await readFile(join(stateDirectory, "requests", `${pre.request_id}.json`), "utf8"),
  );
  assert.equal(preRequest.current_call.tool_call_id, callID);
  assert.equal(await exists(marker), false, "Independent operation ran without pre approval");
  await decide(client, pre, "allow");
  const post = await poll(
    `${callID} post approval`,
    async () => (await pending(client, workdir)).find((item) => item.phase.startsWith("post")),
    state,
  );
  assert.equal(post.session_id, sessionID);
  assert.equal(await readFile(marker, "utf8"), expectedContent);
  await decide(client, post, "allow");
}

async function runScenario(
  scenario: Scenario,
  toolKind: ToolKind = "shell",
  brokenStartup = false,
  disabled = false,
  managedService = false,
) {
  if (
    process.env.SMOKE_CASES &&
    !process.env.SMOKE_CASES.split(",").includes(
      managedService
        ? "managed-service"
        : disabled
          ? "disabled"
          : brokenStartup
            ? "startup-failure"
            : `${toolKind}/${scenario}`,
    )
  )
    return;
  const temporary = await mkdtemp(join(tmpdir(), `opencode-sensor-v2-${scenario}-`));
  const workdir = join(temporary, "workspace");
  const stateDirectory = join(temporary, "sensor");
  const browserMarker = join(temporary, "browser-opened.txt");
  const binDirectory = join(temporary, "bin");
  const marker = join(workdir, "first-operation.txt");
  const nextMarker = join(workdir, "subsequent-operation.txt");
  const followupMarker = join(workdir, "followup-operation.txt");
  const sentinel = `SENSOR_PRIVATE_RESULT_${scenario.replaceAll("-", "_")}`;
  await mkdir(workdir, { recursive: true });
  await mkdir(join(temporary, "home"));
  await mkdir(binDirectory);
  for (const name of ["open", "xdg-open"]) {
    const entry = join(binDirectory, name);
    await writeFile(entry, `#!/bin/sh\nprintf 'opened' >> ${shellQuote(browserMarker)}\nexit 97\n`);
    await chmod(entry, 0o755);
  }
  const assertNativeOnly = async () => {
    assert.equal(
      await exists(join(stateDirectory, "control.json")),
      false,
      "Native sensor created a separate approval server control file",
    );
    assert.equal(
      await exists(browserMarker),
      false,
      "Native sensor attempted to launch an external browser",
    );
  };
  if (brokenStartup) await writeFile(stateDirectory, "A file cannot be used as a state directory");
  const model = await mockModel(scenario, marker, nextMarker, followupMarker, sentinel, toolKind);
  let serverState: ProcessState | undefined;
  const completedOutput: string[] = [];
  let passed = false;
  try {
    // A real persistent harness owns every native form, including approve-only cases.
    const portReservation = createServer();
    portReservation.listen(0, "127.0.0.1");
    await once(portReservation, "listening");
    const address = portReservation.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await stopServer(portReservation);
    const configPath = join(workdir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          snapshots: false,
          warming: false,
          model: "sensor-smoke/deterministic",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          mcp: {
            servers:
              toolKind === "mcp"
                ? {
                    sensor_fixture: {
                      type: "local",
                      codemode: false,
                      command: [
                        process.execPath,
                        join(packageDirectory, "scripts/mcp-fixture.mjs"),
                      ],
                    },
                  }
                : {},
          },
          plugins: [
            {
              package: pathToFileURL(pluginPackage).href,
              options: {
                enabled: !disabled,
                stateDirectory,
                serverURL: managedService ? undefined : baseUrl,
                // Obsolete options must not resurrect the old external approval page.
                openBrowser: true,
                apiTimeoutMs: 2_000,
                classifierTimeoutMs: 3_000,
              },
            },
          ],
          providers: {
            "sensor-smoke": {
              package: "@opencode/ai/providers/openai-compatible",
              activation: "enabled",
              name: "Local deterministic smoke fixture",
              settings: { baseURL: model.baseURL, apiKey: "local-smoke-only" },
              models: {
                deterministic: {
                  name: "Deterministic",
                  capabilities: { tools: true },
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
      PATH: `${binDirectory}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: temporary,
      HOME: join(temporary, "home"),
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
      OPENCODE_PASSWORD: randomBytes(24).toString("hex"),
    };
    serverState = startProcess(
      [
        "serve",
        ...(managedService ? ["--service"] : []),
        "--hostname",
        "127.0.0.1",
        "--port",
        String(address.port),
        "--print-logs",
      ],
      workdir,
      environment,
    );
    const endpoint = managedService
      ? await poll(
          "managed OpenCode service registration",
          () =>
            Service.discover({
              file: join(environment.XDG_STATE_HOME, "opencode", "service.json"),
              version: "2.0.22",
            }),
          serverState,
        )
      : undefined;
    const client = OpenCode.make({
      baseUrl: endpoint?.url ?? baseUrl,
      headers: endpoint
        ? Service.headers(endpoint)
        : {
            Authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_PASSWORD}`).toString("base64")}`,
          },
    });
    await poll(
      "persistent OpenCode server",
      async () => {
        try {
          const info = await client.server.info({ signal: AbortSignal.timeout(2_000) });
          assert.equal(info.pid, serverState!.child.pid);
          return true;
        } catch {
          return undefined;
        }
      },
      serverState,
    );
    const state = serverState;
    const session = await client.session.create({
      location: { directory: workdir },
      model: { providerID: "sensor-smoke", id: "deterministic" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    const waitForTurn = async (completion: string) => {
      await client.session.wait(
        { sessionID: session.id },
        {
          signal: AbortSignal.timeout(stageTimeoutMs),
        },
      );
      await poll(
        completion,
        async () => {
          const messages = await client.message.list(
            { sessionID: session.id, limit: 100 },
            {
              signal: AbortSignal.timeout(2_000),
            },
          );
          const complete = messages.data.some(
            (message) =>
              message.type === "assistant" &&
              message.time.completed &&
              message.content.some(
                (part) => part.type === "text" && part.text.includes(completion),
              ),
          );
          if (!complete) return undefined;
          const active = await client.session.active({ signal: AbortSignal.timeout(2_000) });
          if (active[session.id]) return undefined;
          completedOutput.push(JSON.stringify(messages.data));
          return true;
        },
        state,
      );
    };
    await client.session.prompt({
      sessionID: session.id,
      text: "Run the local smoke operation, then finish.",
    });

    if (disabled || toolKind === "none") {
      await waitForTurn("SMOKE_COMPLETE");
      assert.deepEqual(model.failures, []);
      if (disabled) {
        assert.equal(await readFile(marker, "utf8"), "executed");
        assert.equal(model.primaryRequests.length, 2);
        assert.ok(
          model.allRequests.some((request) =>
            request.messages.some(
              (message: Json) =>
                message.role === "tool" && JSON.stringify(message.content).includes(sentinel),
            ),
          ),
        );
        assert.equal(
          await exists(stateDirectory),
          false,
          "Disabled sensor created state or audit files",
        );
        assert.ok(state.output.includes("enabled=false"), "Disabled mode was not reported");
        console.log("PASS disabled: model and tool complete without sensor UI, state or approvals");
      } else {
        assert.equal(model.primaryRequests.length, 1);
        assert.equal(await exists(marker), false);
        assert.deepEqual(await readdir(join(stateDirectory, "requests")), []);
        assert.ok(state.output.includes("Заглушка классификатора включена"));
        console.log(
          "PASS text-only: enabled protection permits a normal model response without tool approvals",
        );
      }
      await assertNativeOnly();
      assert.deepEqual(await pending(client, workdir), []);
      passed = true;
      return;
    }
    if (brokenStartup) {
      await waitForTurn("SMOKE_COMPLETE");
      assert.deepEqual(model.failures, []);
      assert.equal(await exists(marker), false, "Operation escaped after sensor startup failure");
      assert.equal(model.primaryRequests.length, 2, "Startup failure prevented model continuation");
      assert.ok(
        model.allRequests.some((request) =>
          request.messages.some(
            (message: Json) =>
              message.role === "tool" &&
              JSON.stringify(message.content).includes("Карантин: действие заблокировано.") &&
              JSON.stringify(message.content).includes("Сенсор не готов к проверке действия.") &&
              JSON.stringify(message.content).includes(
                "Это техническая отмена проверки, а не сообщение об обнаруженной атаке.",
              ) &&
              JSON.stringify(message.content).includes("Сессия остаётся доступной."),
          ),
        ),
        "Startup failure did not become a safe tool error",
      );
      assert.ok(
        state.output.includes("Сенсор не запустился"),
        "Expected registered sensor startup failure",
      );
      await assertNativeOnly();
      assert.deepEqual(await pending(client, workdir), []);
      passed = true;
      console.log("PASS startup-failure: tool blocked; model and text response complete normally");
      return;
    }
    const pre = await poll(
      "native pre approval",
      async () => {
        const items = await pending(client, workdir);
        if (toolKind === "mcp") {
          for (const item of items.filter((item) => item.tool === "shell"))
            await decide(client, item, "allow");
          return items.find((item) => item.tool !== "shell" && item.phase.startsWith("pre"));
        }
        return items.find((item) => item.phase.startsWith("pre"));
      },
      state,
    );
    assert.equal(pre.session_id, session.id, "Native approval belongs to a different session");
    assert.ok(pre.request_id && pre.binding_digest);
    assert.equal(await exists(marker), false, "Pre gate allowed the operation before approval");
    await pause(300);
    assert.equal(await exists(marker), false, "Operation ran while the pre approval was pending");

    await assertAuditContext(stateDirectory, pre, `${scenario}/pre`);

    if (scenario === "reject-pre" || scenario === "cancel-pre") {
      await decide(client, pre, scenario === "cancel-pre" ? "cancel" : "reject");
    } else {
      await decide(client, pre, "allow");
      const post = await poll(
        "post approval",
        async () => (await pending(client, workdir)).find((item) => item.phase.startsWith("post")),
        state,
      );
      if (toolKind !== "read-error") assert.equal(await readFile(marker, "utf8"), "executed");
      else {
        const request = JSON.parse(
          await readFile(join(stateDirectory, "requests", `${post.request_id}.json`), "utf8"),
        );
        assert.equal(request.checkpoint.raw_input.status, "error");
        assert.equal(request.current_call.result.format, "v2_tool_error");
        assert.ok(request.current_call.result.native.message.includes(sentinel));
      }
      assert.notEqual(post.request_id, pre.request_id, "Pre and post need separate requests");
      await assertAuditContext(stateDirectory, post, `${scenario}/post`);
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
      await decide(client, post, scenario === "approve" ? "allow" : "reject");
    }

    if (scenario !== "approve") {
      await approveIndependentCall(
        client,
        workdir,
        stateDirectory,
        state,
        pre.session_id,
        nextMarker,
        "independent",
        "call_smoke_subsequent",
      );
    }
    await waitForTurn("SMOKE_COMPLETE");
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
    } else if (scenario === "reject-pre" || scenario === "cancel-pre") {
      assert.equal(await exists(marker), false, "Rejected operation created its marker");
      assert.equal(resultForwarded, false, "Rejected pre call produced a private result");
      assertQuarantineFeedback(forwardedResults, pre.tool, "pre");
    } else {
      assert.equal(resultForwarded, false, "Rejected post result reached the model");
      assertQuarantineFeedback(forwardedResults, pre.tool, "post", toolKind === "read-error");
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
      await client.session.prompt({
        sessionID: session.id,
        text: "Run the follow-up smoke operation in this same session, then finish. FOLLOW_UP_TURN",
      });
      await approveIndependentCall(
        client,
        workdir,
        stateDirectory,
        state,
        pre.session_id,
        followupMarker,
        "followup",
        "call_smoke_followup",
      );
      await waitForTurn("SMOKE_FOLLOWUP_COMPLETE");
      assert.equal(await readFile(followupMarker, "utf8"), "followup");
      const host = await client.server.info({ signal: AbortSignal.timeout(2_000) });
      assert.equal(host.pid, serverState.child.pid, "OpenCode host changed between turns");
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
    await assertNativeOnly();
    assert.deepEqual(
      await pending(client, workdir),
      [],
      "Native approval remained pending after completion",
    );
    passed = true;
    console.log(
      `PASS ${managedService ? "managed-service" : `${toolKind}/${scenario}`}: ${model.primaryRequests.length} primary model request(s)`,
    );
  } catch (error) {
    await writeFile(
      join(temporary, "opencode.log"),
      diagnostics([...completedOutput, serverState?.output ?? ""].join("\n")),
    );
    await writeFile(
      join(temporary, "model-requests.json"),
      JSON.stringify(model.allRequests, null, 2),
    );
    console.error(`Smoke artifacts retained at ${temporary}`);
    throw error;
  } finally {
    await stopProcess(serverState);
    await stopServer(model.server);
    if (passed && process.env.KEEP_SMOKE_ARTIFACTS !== "1")
      await rm(temporary, { recursive: true, force: true });
    else if (passed) {
      await writeFile(
        join(temporary, "model-requests.json"),
        JSON.stringify(model.allRequests, null, 2),
      );
      await writeFile(
        join(temporary, "session-transcripts.json"),
        `[${completedOutput.join(",")}]\n`,
      );
      await writeFile(join(temporary, "opencode.log"), diagnostics(serverState?.output ?? ""));
      console.log(`Smoke artifacts retained at ${temporary}`);
    }
  }
}

await access(join(pluginPackage, "package.json"));
await access(executable);
const version = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  env: {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    HOME: await mkdtemp(join(tmpdir(), "oc2-version-")),
    XDG_DATA_HOME: await mkdtemp(join(tmpdir(), "oc2-version-data-")),
  },
});
assert.equal(version.status, 0, version.stderr);
assert.match(
  version.stdout.trim(),
  /^opencode v2\.0\.22(?:\s|$)/,
  "Live smoke requires the pinned OpenCode 2.0.22",
);
for (const scenario of ["approve", "reject-pre", "reject-post", "cancel-pre"] as const)
  await runScenario(scenario);

for (const scenario of ["approve", "reject-post"] as const) await runScenario(scenario, "mcp");

for (const scenario of ["approve", "reject-post"] as const)
  await runScenario(scenario, "read-error");
await runScenario("approve", "shell", true);
await runScenario("approve", "none");
await runScenario("approve", "shell", false, true);
await runScenario("approve", "shell", false, false, true);
