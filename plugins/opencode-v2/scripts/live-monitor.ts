import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Actual pinned OpenCode + actual Python monitor, with a local scripted model.
// This verifies enforcement/lifecycle plumbing, not model or classifier quality.
type Json = Record<string, any>;
type Scenario =
  | "allow-write"
  | "block-write"
  | "approve-write"
  | "reject-write"
  | "sensitive-read"
  | "unavailable";
type ProcessState = { child: ChildProcess; exited: boolean; code: number | null; output: string };
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const pluginPackage = resolve(process.env.SENSOR_PLUGIN_PACKAGE ?? packageDirectory);
const executable = process.env.OPENCODE_BIN ?? join(packageDirectory, "node_modules/.bin/opencode");
const python = process.env.MONITOR_PYTHON ?? "python3";
const timeoutMs = Number(process.env.MONITOR_LIVE_TIMEOUT_MS ?? 60_000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function diagnostics(value: string) {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(-8_000);
}

function observe(child: ChildProcess): ProcessState {
  const state: ProcessState = { child, exited: false, code: null, output: "" };
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      state.output = (state.output + chunk).slice(-128_000);
    });
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

async function stopProcess(state: ProcessState | undefined) {
  if (!state || state.exited) return;
  state.child.kill("SIGTERM");
  for (let attempt = 0; attempt < 40 && !state.exited; attempt++) await pause(50);
  if (!state.exited) {
    state.child.kill("SIGKILL");
    await once(state.child, "exit");
  }
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function poll<T>(
  label: string,
  check: () => Promise<T | undefined>,
  state?: ProcessState,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await check();
    if (found !== undefined) return found;
    if (state?.exited)
      throw new Error(
        `Process exited before ${label} (${state.code}).\n${diagnostics(state.output)}`,
      );
    await pause(75);
  }
  throw new Error(`Timed out waiting for ${label}.\n${diagnostics(state?.output ?? "")}`);
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await stopServer(server);
  return port;
}

function complete(response: ServerResponse, request: Json, message: Json, finishReason: string) {
  const common = {
    id: `chatcmpl-monitor-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
  if (request.stream) {
    const delta = { ...message };
    if (delta.tool_calls)
      delta.tool_calls = delta.tool_calls.map((call: Json, index: number) => ({ ...call, index }));
    const chunk = {
      ...common,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
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

async function mockModel(toolName: "read" | "write", target: string, content: string) {
  const requests: Json[] = [];
  const primaryRequests: Json[] = [];
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(raw.length < 8 * 1024 * 1024, "Model request too large");
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const tool = body.tools?.find((item: Json) => item.function?.name === toolName);
      if (!tool) {
        assert.ok(!body.tools?.length, `Native ${toolName} tool missing from model catalog`);
        complete(
          response,
          body,
          { role: "assistant", content: "Monitor integration smoke" },
          "stop",
        );
        return;
      }
      primaryRequests.push(body);
      const results = body.messages.filter((item: Json) => item.role === "tool");
      if (results.length) {
        complete(response, body, { role: "assistant", content: "MONITOR_LIVE_COMPLETE" }, "stop");
        return;
      }
      complete(
        response,
        body,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_monitor_live_first",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(
                  toolName === "read" ? { path: target } : { path: target, content },
                ),
              },
            },
          ],
        },
        "tool_calls",
      );
    } catch (error) {
      failures.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Monitor live model fixture failed" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    requests,
    primaryRequests,
    failures,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function jsonRequest(origin: string, path: string, adminToken: string, body?: Json) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200, `${path} failed: ${await response.clone().text()}`);
  return (await response.json()) as Json;
}

async function runScenario(scenario: Scenario) {
  if (
    process.env.MONITOR_LIVE_CASES &&
    !process.env.MONITOR_LIVE_CASES.split(",").includes(scenario)
  )
    return;
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), `opencode-monitor-v2-${scenario}-`)),
  );
  const workdir = join(temporary, "workspace");
  const stateDirectory = join(temporary, "sensor");
  const target = join(
    workdir,
    scenario === "sensitive-read" ? "customer-record.txt" : "executed.txt",
  );
  const content =
    scenario === "sensitive-read" ? "MONITOR_SECRET_LIVE_READ\n" : "MONITOR_LIVE_WRITE\n";
  const adminToken = randomBytes(32).toString("hex");
  let monitor: ProcessState | undefined;
  let agent: ProcessState | undefined;
  let model: Awaited<ReturnType<typeof mockModel>> | undefined;
  let passed = false;
  try {
    await mkdir(workdir);
    if (scenario === "sensitive-read") await writeFile(target, content);
    const policyPath = join(temporary, "trusted-policy.yaml");
    let policy = await readFile(
      join(repositoryDirectory, "e2e_classifier/config/policies.yaml"),
      "utf8",
    );
    if (scenario === "approve-write" || scenario === "reject-write") {
      assert.ok(policy.includes("write: {effect: write, path_argument: path}"));
      policy = policy.replace(
        "write: {effect: write, path_argument: path}",
        "write: {effect: destructive, path_argument: path}",
      );
    }
    await writeFile(policyPath, policy, { mode: 0o600 });
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    monitor = observe(
      spawn(python, ["-m", "agent_monitor.cli", "serve", "--port", String(port)], {
        cwd: join(repositoryDirectory, "e2e_classifier"),
        env: {
          ...process.env,
          PYTHONPATH: join(repositoryDirectory, "e2e_classifier/src"),
          MONITOR_ADMIN_TOKEN: adminToken,
          MONITOR_POLICY: policyPath,
          MONITOR_DB: join(temporary, "state.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await poll(
      "Python monitor health (set MONITOR_PYTHON to a Python with monitor dependencies)",
      async () => {
        try {
          const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) return true;
        } catch {
          /* service is starting */
        }
        return undefined;
      },
      monitor,
    );
    const credentials = await jsonRequest(origin, "/v1/runs", adminToken, {
      goal: "Run one local monitor integration operation, then finish.",
      workspace: workdir,
      profile: scenario === "block-write" || scenario === "sensitive-read" ? "review" : "implement",
    });
    const credentialsPath = join(temporary, "run.credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({ ...credentials, url: origin, workspace: workdir }),
      { mode: 0o600 },
    );
    const inspect = () => jsonRequest(origin, `/v1/runs/${credentials.run_id}/events`, adminToken);
    model = await mockModel(scenario === "sensitive-read" ? "read" : "write", target, content);
    const configPath = join(workdir, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          share: "disabled",
          snapshots: false,
          warming: false,
          model: "monitor-smoke/deterministic",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          mcp: { servers: {} },
          plugins: [
            {
              package: pathToFileURL(pluginPackage).href,
              options: {
                enabled: true,
                backend: "agent_monitor",
                monitorCredentials: credentialsPath,
                stateDirectory,
                openBrowser: false,
                apiTimeoutMs: 2_000,
              },
            },
          ],
          providers: {
            "monitor-smoke": {
              package: "@opencode/ai/providers/openai-compatible",
              activation: "enabled",
              name: "Local deterministic monitor fixture",
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
    if (scenario === "unavailable") await stopProcess(monitor);
    agent = observe(
      spawn(
        executable,
        [
          "run",
          "--standalone",
          "--auto",
          "--print-logs",
          "--format",
          "json",
          "--model",
          "monitor-smoke/deterministic",
          "Run one local monitor integration operation, then finish.",
        ],
        {
          cwd: workdir,
          env: {
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
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
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    if (scenario === "approve-write" || scenario === "reject-write") {
      const approval = await poll(
        "monitor exact-call approval",
        async () => {
          const report = await inspect();
          return report.events.find(
            (event: Json) => event.type === "decision" && event.decision === "REQUIRE_APPROVAL",
          );
        },
        agent,
      );
      assert.ok(approval.approval_id);
      assert.equal(await exists(target), false, "Write ran before operator approval");
      await pause(300);
      assert.equal(await exists(target), false, "Write ran while approval was pending");
      assert.equal(
        model.primaryRequests.length,
        1,
        "Model continued while exact-call approval was pending",
      );
      const pendingReport = await inspect();
      assert.equal(
        pendingReport.events.some(
          (event: Json) => event.type === "started" || event.type === "result",
        ),
        false,
      );
      await jsonRequest(origin, `/v1/approvals/${approval.approval_id}`, adminToken, {
        approve: scenario === "approve-write",
      });
    }
    await poll("OpenCode completion", async () => (agent!.exited ? true : undefined));
    assert.deepEqual(model.failures, [], diagnostics(agent.output));
    if (scenario === "unavailable") {
      assert.equal(await exists(target), false, "Tool ran with unavailable monitor");
      assert.equal(
        model.requests.length,
        0,
        "Model request escaped unavailable monitor at startup",
      );
    } else {
      const report = await inspect();
      const decisions = report.events.filter((event: Json) => event.type === "decision");
      const started = report.events.filter((event: Json) => event.type === "started");
      const results = report.events.filter((event: Json) => event.type === "result");
      if (scenario === "block-write" || scenario === "reject-write") {
        assert.equal(await exists(target), false, "Blocked operation executed");
        assert.equal(started.length, 0, "Blocked operation received execution start");
        assert.equal(results.length, 0, "Blocked operation reported completion");
        assert.equal(report.run.calls, 0);
        assert.ok(
          decisions.some(
            (event: Json) =>
              event.decision === (scenario === "block-write" ? "BLOCK" : "REQUIRE_APPROVAL"),
          ),
        );
      } else {
        assert.equal(agent.code, 0, diagnostics(agent.output));
        assert.equal(await readFile(target, "utf8"), content);
        const allowed = decisions.filter((event: Json) => event.decision === "ALLOW");
        assert.equal(allowed.length, 1, "Expected exactly one allowed tool call");
        assert.equal(started.length, 1);
        assert.equal(results.length, 1);
        assert.equal(started[0].call_id, allowed[0].call_id);
        assert.equal(results[0].call_id, allowed[0].call_id);
        assert.equal(results[0].status, "completed");
        assert.equal(report.run.calls, 1);
        const startIndex = report.events.indexOf(started[0]);
        assert.ok(startIndex > report.events.indexOf(allowed[0]));
        assert.ok(report.events.indexOf(results[0]) > startIndex);
        assert.ok(agent.output.includes("MONITOR_LIVE_COMPLETE"), "Model did not finish normally");
        if (scenario === "approve-write") {
          const pending = decisions.find((event: Json) => event.decision === "REQUIRE_APPROVAL");
          assert.ok(pending);
          assert.equal(pending.call_id, allowed[0].call_id);
          assert.equal(pending.action_hash, allowed[0].action_hash);
          assert.ok(
            report.events.some((event: Json) => event.type === "approval" && event.approved),
          );
        }
        if (scenario === "sensitive-read") {
          assert.equal(allowed[0].sensitive_run, true, "Native read must taint before execution");
          assert.equal(report.run.sensitive, true);
          assert.equal(results[0].sensitive_run, true);
          assert.ok(
            model.requests.some((request: Json) =>
              request.messages.some(
                (message: Json) =>
                  message.role === "tool" &&
                  JSON.stringify(message.content).includes(content.trim()),
              ),
            ),
            "Read result did not reach model after monitor recording",
          );
        }
      }
      assert.ok(
        report.events.some((event: Json) => event.type === "content" && event.source === "user"),
        "User prompt not recorded before execution",
      );
    }
    passed = true;
    console.log(`PASS agent_monitor/${scenario}: actual OpenCode 2.0.22 + Python service`);
  } catch (error) {
    await writeFile(join(temporary, "opencode.log"), diagnostics(agent?.output ?? ""));
    await writeFile(join(temporary, "monitor.log"), diagnostics(monitor?.output ?? ""));
    console.error(`Monitor live artifacts retained at ${temporary}`);
    throw error;
  } finally {
    await stopProcess(agent);
    await stopProcess(monitor);
    if (model) await stopServer(model.server);
    if (passed && process.env.KEEP_SMOKE_ARTIFACTS !== "1")
      await rm(temporary, { recursive: true, force: true });
    else if (passed) console.log(`Monitor live artifacts retained at ${temporary}`);
  }
}

await access(join(pluginPackage, "package.json"));
await access(executable);
const versionTemporary = await mkdtemp(join(tmpdir(), "opencode-monitor-version-"));
try {
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: join(versionTemporary, "home"),
      XDG_DATA_HOME: join(versionTemporary, "data"),
    },
  });
  assert.equal(version.status, 0, version.stderr);
  assert.match(
    version.stdout.trim(),
    /^opencode v2\.0\.22(?:\s|$)/,
    "Monitor live test requires pinned OpenCode 2.0.22",
  );
} finally {
  await rm(versionTemporary, { recursive: true, force: true });
}
for (const scenario of [
  "allow-write",
  "block-write",
  "approve-write",
  "reject-write",
  "sensitive-read",
  "unavailable",
] as const)
  await runScenario(scenario);
