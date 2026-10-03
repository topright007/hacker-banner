import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { serializeError } from "./sanitize.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ApprovalServer } from "./approval-server.js";
import { AuditLog } from "./audit.js";
import { denyAllClassifier, type Classifier } from "./classifier.js";
import { ContextCollector } from "./collector.js";
import { SessionBlockedError, SessionGates } from "./gates.js";
import {
  assertResponse,
  bindRequest,
  digest,
  id,
  jsonCopy,
  responseFor,
  type ClassifierRequest,
  type ClassifierResponse,
  type Native,
  type Phase,
} from "./protocol.js";

export interface SensorOptions {
  enabled?: boolean;
  stateDirectory?: string;
  openBrowser?: boolean;
  apiTimeoutMs?: number;
  classifierTimeoutMs?: number;
}

export type SensorInput = Plugin.Context;

export interface ApprovalUI {
  start(): Promise<void>;
  ask(request: ClassifierRequest, response: ClassifierResponse): Promise<"allow" | "reject">;
  cancelSession(sessionIDs: string[]): void;
  close(): Promise<void>;
}

export interface SensorDependencies {
  classifier?: Classifier;
  approvals?: ApprovalUI;
}

function milliseconds(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 120_000) {
    throw new Error("Sensor timeouts must be integer milliseconds between 1 and 120000");
  }
  return Number(value);
}

function eventSession(event: Native): string | undefined {
  return typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined;
}

/** Error properties are otherwise lost by JSON serialization. */
function snapshotToolEvent(event: Native): Native {
  return jsonCopy(
    event.status === "error" ? { ...event, error: serializeError(event.error) } : event,
  );
}

function toolOutput(phase: Phase, event: Native): Native | null {
  if (phase === "pre_tool_call") return event.input ?? null;
  return event.status === "error" ? serializeError(event.error) : event.result;
}

export async function createSensor(
  ctx: SensorInput,
  suppliedOptions: unknown = {},
  dependencies: SensorDependencies = {},
): Promise<Record<string, any>> {
  const validOptions =
    suppliedOptions !== null &&
    typeof suppliedOptions === "object" &&
    !Array.isArray(suppliedOptions);
  const options = validOptions ? (suppliedOptions as SensorOptions) : {};
  // An explicit boolean false is the only off switch. Exit before reading the
  // harness context or initializing any collector, hooks, state, or service.
  if (validOptions && Object.hasOwn(options, "enabled") && options.enabled === false) {
    process.stderr.write(
      "[OpenCode Sensor V2] Защита отключена: enabled=false. Hooks и локальные сервисы сенсора не запущены.\n",
    );
    return { dispose: async () => {} };
  }
  let startupFailure: unknown = validOptions
    ? undefined
    : new Error("Sensor options must be an object");
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    startupFailure = new Error("Sensor enabled must be boolean");
  const instanceID = id("instance");
  const runID = id("run");
  let apiTimeoutMs = 5000;
  let classifierTimeoutMs = 3000;
  try {
    apiTimeoutMs = milliseconds(options.apiTimeoutMs, 5000);
    classifierTimeoutMs = milliseconds(options.classifierTimeoutMs, 3000);
  } catch (error) {
    startupFailure = error;
  }
  const workspaceHash = createHash("sha256")
    .update(ctx.location.directory)
    .digest("hex")
    .slice(0, 16);
  if (
    options.stateDirectory !== undefined &&
    (typeof options.stateDirectory !== "string" || !isAbsolute(options.stateDirectory))
  ) {
    startupFailure = new Error("Sensor stateDirectory must be an absolute path");
  }
  if (options.openBrowser !== undefined && typeof options.openBrowser !== "boolean")
    startupFailure = new Error("Sensor openBrowser must be boolean");
  const stateDirectory =
    typeof options.stateDirectory === "string" && isAbsolute(options.stateDirectory)
      ? resolve(options.stateDirectory)
      : join(homedir(), ".local", "state", "opencode-sensor-v2", workspaceHash, instanceID);
  const collector = new ContextCollector({ ctx, apiTimeoutMs });
  const gates = new SessionGates(collector.knownParents);
  const audit = new AuditLog(stateDirectory);
  const classifier = dependencies.classifier ?? denyAllClassifier;
  let sequence = 0;
  let closed = false;
  const preCalls = new Map<string, { token: symbol; observedAt: number }[]>();
  const ambiguousPreCalls = new Set<string>();
  const active = new Map<symbol, string>();
  const executingCheckpoints = new Map<symbol, string>();
  const registrations: { dispose(): Promise<void> }[] = [];
  const eventController = new AbortController();
  let eventTask: Promise<void> | undefined;
  let startupResolved = false;
  let resolveStartup!: () => void;
  const startup = new Promise<void>((resolve) => {
    resolveStartup = resolve;
  });

  async function notice(message: string, _variant = "warning"): Promise<void> {
    // Server plugins do not have a TUI/toast API. Never print the private token.
    process.stderr.write(`[OpenCode Sensor V2] ${message}\n`);
  }
  function notify(message: string, variant = "warning"): void {
    void notice(message, variant).catch(() => undefined);
  }
  async function ready(sessionID?: string): Promise<void> {
    if (!startupResolved) await startup;
    if (closed || startupFailure) {
      if (sessionID) stop(sessionID);
      throw new SessionBlockedError();
    }
  }

  const approvals =
    dependencies.approvals ??
    new ApprovalServer({
      stateDirectory,
      openBrowser: options.openBrowser ?? true,
      onNotice: (message) => notice(message),
    });

  function relatedSessions(sessionID: string): string[] {
    return [
      ...new Set([
        sessionID,
        ...collector.relevantSessionIds(sessionID),
        ...active.values(),
        ...executingCheckpoints.values(),
      ]),
    ].filter((id) => gates.related(id, sessionID));
  }

  function stop(sessionID: string): void {
    const alreadyBlocked = gates.isBlocked(sessionID);
    gates.block(sessionID);
    const sessions = relatedSessions(sessionID);
    approvals.cancelSession(sessions);
    if (alreadyBlocked) return;
    // Awaiting abort from inside the hook can deadlock with harness waiting for
    // the same hook to unwind. The latch is synchronous; abort is best effort.
    for (const session of sessions) {
      void Promise.resolve()
        .then(() =>
          ctx.session.interrupt(
            { sessionID: session as any, resume: false },
            { signal: AbortSignal.timeout(apiTimeoutMs) },
          ),
        )
        .catch(() => undefined);
    }
  }

  async function record(
    request: ClassifierRequest,
    source: "plugin.classifier" | "plugin.user_override",
    decision: string,
    reason: string | null,
  ): Promise<void> {
    const entry = {
      decision_id: id("decision"),
      source,
      session_id: request.current_call.session_id,
      tool_call_id: request.current_call.tool_call_id,
      hook_call_id: request.current_call.hook_call_id,
      classifier_request_id: request.request_id,
      permission_request_id: null,
      phase: request.phase,
      decision,
      reason,
      scope: source === "plugin.user_override" && decision === "deny" ? "session_tree" : "call",
      binding_digest: request.decision_binding.digest,
      decided_at_ms: Date.now(),
      native: null,
    };
    collector.recordApproval(entry);
    try {
      await audit.decision(entry);
    } catch {
      notify("Не удалось сохранить решение в локальном журнале.", "error");
    }
  }

  async function classify(request: ClassifierRequest): Promise<ClassifierResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("CLASSIFIER_TIMEOUT"));
        }, classifierTimeoutMs);
      });
      // The classifier receives a detached copy, preserving the checked request
      // used by the human UI even if a future adapter mutates its input.
      const response = await Promise.race([
        classifier(jsonCopy(request), controller.signal),
        timeout,
      ]);
      assertResponse(request, response);
      return response;
    } catch (error) {
      return responseFor(request, {
        status: "unavailable",
        decision: null,
        reason: null,
        error: {
          code: controller.signal.aborted ? "CLASSIFIER_TIMEOUT" : "CLASSIFIER_FAILURE",
          message: error instanceof Error ? error.message : "Classifier failure",
          retryable: true,
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function checkpoint(phase: Phase, hookInput: Native): Promise<void> {
    // Detach mutable native hook evidence before any SDK or approval awaits.
    const observedAt = Date.now();
    const sessionID = hookInput.sessionID as string;
    let originalInput: Native;
    let originalOutput: Native | null;
    let inputDigest: string;
    try {
      originalInput = snapshotToolEvent(hookInput);
      originalOutput = jsonCopy(toolOutput(phase, originalInput));
      inputDigest = digest(originalInput.input ?? null);
    } catch (error) {
      stop(sessionID);
      throw error;
    }
    // CodeMode reuses its outer call ID for nested tools. Retain every observed
    // invocation; do not invent an exact pairing for concurrent identical calls.
    const key = `${sessionID}\u0000${originalInput.messageID}\u0000${originalInput.id}\u0000${originalInput.tool}\u0000${inputDigest}`;
    const calls = preCalls.get(key) ?? [];
    const call = phase === "pre_tool_call" ? { token: Symbol(key), observedAt } : calls[0];
    const preObservedAt =
      phase === "pre_tool_call"
        ? observedAt
        : calls.length === 1 && !ambiguousPreCalls.has(key)
          ? calls[0].observedAt
          : null;
    if (phase === "pre_tool_call") {
      if (calls.length > 0) ambiguousPreCalls.add(key);
      calls.push(call!);
      preCalls.set(key, calls);
      active.set(call!.token, sessionID);
    } else if (call) {
      calls.shift();
      if (!calls.length) {
        preCalls.delete(key);
        ambiguousPreCalls.delete(key);
      }
    }
    const checkpointToken = Symbol(key);
    executingCheckpoints.set(checkpointToken, sessionID);
    try {
      await ready(sessionID);
      await gates.wait(sessionID);
      const collected = await collector.collect({
        phase,
        hookInput: originalInput,
        hookOutput: originalOutput,
        preObservedAt,
        observedAt,
        gate: {
          state: "awaiting_classifier",
          scope_session_ids: relatedSessions(sessionID),
          reason: null,
        },
      });
      // Parent discovery can reveal a tree that was already rejected while the
      // SDK requests were in flight. Never downgrade that latch to fail-open.
      await gates.wait(sessionID);
      const request = bindRequest({
        contract: "opencode-plugin-classifier",
        contract_version: "2.0.0",
        request_id: id("req"),
        phase,
        harness: { name: "opencode", version: ctx.app.version, plugin_api: "v2" },
        snapshot: {
          mode: "live",
          snapshot_id: id("snapshot"),
          plugin_instance_id: instanceID,
          run_id: runID,
          sequence: ++sequence,
          collection_started_at_ms: collected.collection_started_at_ms,
          collection_finished_at_ms: collected.collection_finished_at_ms,
          checkpoint_reference_at_ms: observedAt,
          atomic: false,
          history_transport: "active_and_observed",
          limitations: [
            "API snapshots span time; already-running sibling tools can finish while this hook waits.",
            "Semantic context and wire hooks are separate observations; exact request correlation is not provided by the V2 API.",
            "Later plugins may mutate the checked output. Run this sensor last and restrict other plugins.",
            "Active session context and events observed since attachment are available; compacted-away archive is not exposed by Plugin Context.",
            "Post hooks cover completed calls and Tool.Error failures, not every cancellation or runtime defect.",
            "Provider-hosted tools and shell operations outside local tool execution are outside this checkpoint boundary.",
            "CodeMode nested tools reuse the outer call ID; concurrent identical calls have no unique native pairing key.",
          ],
        },
        checkpoint: {
          hook: phase === "pre_tool_call" ? "tool.execute.before" : "tool.execute.after",
          stage: phase === "pre_tool_call" ? "before_execution" : "before_result_release",
          held_by_plugin: true,
          raw_input: originalInput,
          raw_output: originalOutput,
        },
        current_call: collected.current_call,
        context: collected.context,
        coverage: collected.coverage,
        enforcement: {
          classifier_unavailable: "allow_with_harness_permissions",
          classifier_deny: "ask_user",
          user_allow: "allow_once_for_bound_checkpoint",
          user_reject: "block_session_tree_and_request_abort",
          user_no_response: "keep_blocked",
          classifier_timeout_ms: classifierTimeoutMs,
        },
      });
      try {
        await audit.request(request);
      } catch {
        notify(
          "Не удалось сохранить снимок запроса классификатору. Проверка и подтверждение остаются включены.",
          "error",
        );
      }
      const response = await classify(request);
      if (response.status === "unavailable") {
        await record(
          request,
          "plugin.classifier",
          "unavailable",
          response.error?.code ?? "Classifier unavailable",
        );
        notify(
          "Классификатор недоступен: применён fail-open. Штатные разрешения OpenCode продолжают действовать.",
        );
      } else {
        if (response.decision === "deny") gates.hold(sessionID, request.request_id);
        await record(request, "plugin.classifier", response.decision!, response.reason);
        if (response.decision === "deny") {
          let decision: "allow" | "reject";
          try {
            decision = await approvals.ask(request, response);
          } catch {
            // A UI failure is not a classifier outage and must never auto-allow.
            stop(sessionID);
            notify("Подтверждение пользователя недоступно. Выполнение остановлено.", "error");
            throw new SessionBlockedError();
          }
          if (decision === "reject") {
            stop(sessionID);
            await record(
              request,
              "plugin.user_override",
              "deny",
              "Пользователь отказал или подтверждение отменено.",
            );
            throw new SessionBlockedError();
          }
          await record(
            request,
            "plugin.user_override",
            "allow",
            "Пользователь разрешил только этот checkpoint.",
          );
          gates.release(request.request_id);
        }
      }
      await gates.wait(sessionID);
      // Never release an approval for a different mutable value than displayed.
      const liveOutput = jsonCopy(toolOutput(phase, hookInput));
      if (
        digest(originalInput) !== digest(snapshotToolEvent(hookInput)) ||
        digest(originalOutput) !== digest(liveOutput)
      ) {
        stop(sessionID);
        notify(
          "Аргументы или результат изменились во время подтверждения. Выполнение остановлено; разрешение устарело.",
          "error",
        );
        throw new SessionBlockedError();
      }
    } catch (error) {
      if (!(error instanceof SessionBlockedError)) {
        // A programming/collection/contract failure must not impersonate a
        // classifier outage. The always-deny MVP must remain reviewable.
        stop(sessionID);
        notify(
          "Ошибка сбора или проверки контракта сенсора. Выполнение остановлено; подробности в логах OpenCode.",
          "error",
        );
        notify(error instanceof Error ? error.message : "Sensor checkpoint failed", "error");
      }
      throw error;
    } finally {
      executingCheckpoints.delete(checkpointToken);
      if (phase === "post_tool_call" || gates.isBlocked(sessionID)) {
        if (call) active.delete(call.token);
        if (gates.isBlocked(sessionID)) {
          preCalls.delete(key);
          ambiguousPreCalls.delete(key);
        }
      }
    }
  }

  const hooks: Record<string, any> = {
    "tool.execute.before": (event: Native) => checkpoint("pre_tool_call", event),
    "tool.execute.after": (event: Native) => checkpoint("post_tool_call", event),
    event: (event: Native) => {
      collector.observeEvent(event);
      const sessionID = eventSession(event);
      if (!sessionID) return;
      // V2 emits the terminal execution event after its fiber is cancelled.
      // Hook promises have no AbortSignal, so cancel the pending UI explicitly.
      // A child finishing normally must not cancel a parent's subagent call.
      const unsettled = [...executingCheckpoints.values()].includes(sessionID);
      if (
        ["session.deleted", "session.execution.interrupted", "session.execution.failed"].includes(
          event.type,
        ) &&
        (unsettled || [...active.values()].includes(sessionID))
      )
        stop(sessionID);
      if (event.type === "session.execution.succeeded" && unsettled) stop(sessionID);
      if (
        event.type.startsWith("session.execution.") &&
        event.type !== "session.execution.started"
      ) {
        for (const [token, activeSession] of active)
          if (activeSession === sessionID) active.delete(token);
        for (const key of preCalls.keys())
          if (key.startsWith(`${sessionID}\u0000`)) {
            preCalls.delete(key);
            ambiguousPreCalls.delete(key);
          }
      }
    },
    dispose: async () => {
      if (closed) return;
      closed = true;
      gates.close();
      eventController.abort();
      await approvals.close();
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      await audit.flush();
      if (eventTask) await eventTask;
    },
  };
  const sessionHooks = [
    "prompt",
    "context",
    "compaction",
    "generate",
    "title",
    "model.request",
    "http.request",
    "http.response",
    "experimental.ws.handshake",
    "experimental.ws.send",
    "experimental.ws.receive",
    "retry",
  ] as const;
  for (const name of sessionHooks) {
    hooks[`session.${name}`] = async (event: Native) => {
      try {
        await ready(event.sessionID);
        // Observe before waiting so parallel/auxiliary calls retain their own evidence.
        await collector.observeHook(`session.${name}`, event);
        await gates.wait(event.sessionID);
      } catch (error) {
        stop(event.sessionID);
        throw error;
      }
    };
  }
  hooks["permission.evaluate"] = async (event: Native) => {
    await ready(event.sessionID);
    await collector.observeHook("permission.evaluate", event);
    await gates.wait(event.sessionID);
    // Do not weaken the configured harness policy; it still runs independently.
  };
  hooks["shell.create.before"] = async (event: Native) => {
    await ready();
    // This hook has no session identity. Never guess one from concurrent activity.
    await collector.observeHook("shell.create.before", event);
  };

  // Register the enforcement surface before starting fallible local services.
  // Throwing setup after registration makes OpenCode unload the plugin: retain
  // registered hooks and fail closed instead of silently losing protection.
  try {
    registrations.push(await ctx.tool.hook("execute.before", hooks["tool.execute.before"]));
    registrations.push(await ctx.tool.hook("execute.after", hooks["tool.execute.after"]));
    for (const name of sessionHooks)
      registrations.push(await ctx.session.hook(name, hooks[`session.${name}`]));
    registrations.push(await ctx.permission.hook("evaluate", hooks["permission.evaluate"]));
    registrations.push(await ctx.shell.hook("create.before", hooks["shell.create.before"]));
    if (ctx.app.version !== "2.0.22")
      throw new Error(`Unsupported OpenCode version ${ctx.app.version}; expected 2.0.22`);
    if (startupFailure) throw startupFailure;
    await audit.start();
    await approvals.start();
    eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (closed) break;
          hooks.event(event);
        }
        if (!closed) throw new Error("OpenCode event subscription ended unexpectedly");
      } catch (error) {
        if (closed || eventController.signal.aborted) return;
        startupFailure = error;
        // Loss of cancellation observation must not leave a stale approval alive.
        for (const sessionID of new Set([...active.values(), ...executingCheckpoints.values()]))
          stop(sessionID);
        notify("Поток событий OpenCode недоступен. Сенсор остановил выполнение.", "error");
      }
    })();
  } catch (error) {
    startupFailure = error;
    notify(
      `Сенсор не запустился; зарегистрированные hooks блокируют выполнение: ${
        error instanceof Error ? error.message : "startup failure"
      }`,
      "error",
    );
  } finally {
    startupResolved = true;
    resolveStartup();
  }
  if (!startupFailure)
    notify(
      `Заглушка классификатора включена: каждый pre/post требует подтверждения. Локальное управление: ${join(stateDirectory, "control.json")}`,
      "info",
    );
  return hooks;
}
