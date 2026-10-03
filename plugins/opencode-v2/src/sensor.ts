import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MonitorBackend, type MonitorDecision, type MonitorOptions } from "./monitor.js";
import type { Plugin } from "@opencode/plugin";
import { serializeError } from "./sanitize.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { NativeApprovalUI } from "./native-approvals.js";
import { createNativeFormsClient } from "./native-client.js";
import { AuditLog } from "./audit.js";
import { QuarantineStore } from "./quarantine-store.js";
import { denyAllClassifier, type Classifier } from "./classifier.js";
import { createJevClassifier } from "./jev.js";
import { ContextCollector } from "./collector.js";
import { ActionRejectedError, quarantineMessage, type QuarantineCause } from "./gates.js";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
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

export interface SensorOptions extends MonitorOptions {
  backend?: "stub" | "jev" | "agent_monitor";
  /** JEV bearer token; overrides the JEV_API_TOKEN environment variable. */
  jevToken?: string;
  enabled?: boolean;
  stateDirectory?: string;
  /** Existing OpenCode server; managed service discovery is used when omitted. */
  serverURL?: string;
  /** @deprecated Ignored. Confirmations are always inside OpenCode. */
  openBrowser?: boolean;
  apiTimeoutMs?: number;
  classifierTimeoutMs?: number;
}

export type SensorInput = Plugin.Context;

export type ApprovalDecision = "allow" | "quarantine" | "reject";

export interface ApprovalUI {
  start(): Promise<void>;
  ask(request: ClassifierRequest, response: ClassifierResponse): Promise<ApprovalDecision>;
  cancelSession(sessionIDs: string[]): void;
  close(): Promise<void>;
}

export interface SensorDependencies {
  classifier?: Classifier;
  approvals?: ApprovalUI;
  monitor?: MonitorBackend;
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
  if (options.jevToken !== undefined && options.backend !== "jev")
    startupFailure = new Error("jevToken requires backend=jev");
  const monitorMode = options.backend === "agent_monitor";
  if (options.backend !== undefined && !["stub", "jev", "agent_monitor"].includes(options.backend))
    startupFailure = new Error("Sensor backend must be stub, jev or agent_monitor");
  if (!monitorMode && (options.monitorCredentials !== undefined || options.toolMap !== undefined))
    startupFailure = new Error("Monitor options require backend=agent_monitor");
  let monitor: MonitorBackend | undefined;
  const monitorDeniedCalls = new Map<string, string>();
  const monitorControllers = new Map<symbol, { sessionID: string; controller: AbortController }>();
  const instanceID = id("instance");
  const runID = id("run");
  let apiTimeoutMs = 5000;
  let classifierTimeoutMs = 3000;
  try {
    apiTimeoutMs = milliseconds(options.apiTimeoutMs, 5000);
    classifierTimeoutMs = milliseconds(
      options.classifierTimeoutMs,
      options.backend === "jev" ? 10000 : 3000,
    );
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
  if (options.serverURL !== undefined && typeof options.serverURL !== "string")
    startupFailure = new Error("Sensor serverURL must be a string");
  const stateDirectory =
    typeof options.stateDirectory === "string" && isAbsolute(options.stateDirectory)
      ? resolve(options.stateDirectory)
      : join(homedir(), ".local", "state", "opencode-sensor-v2", workspaceHash, instanceID);
  const collector = new ContextCollector({ ctx, apiTimeoutMs });
  const audit = new AuditLog(stateDirectory);
  // Session IDs are host-wide. Use a stable store shared by workspace instances,
  // so reloads and delegated sessions cannot silently leave quarantine.
  const quarantine = new QuarantineStore(
    typeof options.stateDirectory === "string" && isAbsolute(options.stateDirectory)
      ? join(stateDirectory, "quarantine")
      : join(homedir(), ".local", "state", "opencode-sensor-v2", "quarantine"),
  );
  const quarantinedHere = new Set<string>();
  const parents = new Map<string, string | null>();
  let classifier = dependencies.classifier ?? denyAllClassifier;
  try {
    if (options.backend === "jev" && !dependencies.classifier)
      classifier = createJevClassifier({ token: options.jevToken });
  } catch (error) {
    startupFailure = error;
  }
  let sequence = 0;
  let closed = false;
  type Invocation = { token: symbol; observedAt: number; sessionID: string; cancelled: boolean };
  const preCalls = new Map<string, Invocation[]>();
  const ambiguousPreCalls = new Set<string>();
  const active = new Map<symbol, Invocation>();
  const executingCheckpoints = new Map<symbol, { sessionID: string; cancelled: boolean }>();
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
  const approvals =
    dependencies.approvals ??
    new NativeApprovalUI({
      client: () =>
        createNativeFormsClient({
          serverURL: options.serverURL,
          channel: ctx.app.channel,
          requestTimeoutMs: apiTimeoutMs,
        }),
      requestTimeoutMs: apiTimeoutMs,
      onNotice: (message) => notice(message),
    });

  async function isQuarantined(sessionID: string): Promise<boolean> {
    const seen = new Set<string>();
    let current: string | null = sessionID;
    while (current) {
      if (seen.has(current) || seen.size >= 64) throw new Error("Invalid session ancestry");
      seen.add(current);
      if (quarantinedHere.has(current) || (await quarantine.isQuarantined(current))) return true;
      if (!parents.has(current)) {
        const known = collector.knownParents.get(current);
        if (known !== undefined) parents.set(current, known);
        else {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const info: { id: string; parentID?: string } = await Promise.race([
              ctx.session.get({ sessionID: current }, { signal: controller.signal }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error("Session ancestry timeout"));
                }, apiTimeoutMs);
              }),
            ]);
            if (
              !info ||
              info.id !== current ||
              (info.parentID != null && typeof info.parentID !== "string")
            )
              throw new Error("Session ancestry unavailable");
            parents.set(current, info.parentID ?? null);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      current = parents.get(current)!;
    }
    // A concurrent answer may have arrived during an ancestry/storage read.
    return [...seen].some((id) => quarantinedHere.has(id));
  }

  function knownDescendants(sessionID: string): string[] {
    const ids = new Set([sessionID]);
    const lineage = new Map([...collector.knownParents, ...parents]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, parent] of lineage)
        if (parent && ids.has(parent) && !ids.has(id)) {
          ids.add(id);
          changed = true;
        }
    }
    return [...ids];
  }

  function locallyQuarantined(sessionID: string): boolean {
    const seen = new Set<string>();
    let current: string | null | undefined = sessionID;
    while (current && !seen.has(current)) {
      if (quarantinedHere.has(current)) return true;
      seen.add(current);
      current = parents.get(current) ?? collector.knownParents.get(current);
    }
    return false;
  }

  function cancelCurrentCheckpoints(sessionID: string): void {
    // Invalidate only work already in flight. A later call in this same session
    // gets a fresh checkpoint and its own approval, without an unblock/reset.
    for (const checkpoint of executingCheckpoints.values())
      if (checkpoint.sessionID === sessionID) checkpoint.cancelled = true;
    for (const call of active.values()) if (call.sessionID === sessionID) call.cancelled = true;
    approvals.cancelSession([sessionID]);
    for (const { sessionID: waitingSession, controller } of monitorControllers.values())
      if (waitingSession === sessionID) controller.abort();
  }

  async function record(
    request: ClassifierRequest,
    source: "plugin.classifier" | "plugin.user_override" | "plugin.monitor",
    decision: string,
    reason: string | null,
    scope: "call" | "session" = "call",
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
      scope,
      binding_digest: request.decision_binding.digest,
      decided_at_ms: Date.now(),
      native: source === "plugin.monitor" ? { monitor_run_id: monitor?.monitorRunID } : null,
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
    const observedAt = Date.now();
    const sessionID = hookInput.sessionID as string;
    // Keep the checked identity even if another plugin changes the live event
    // while the classifier or approval UI is pending.
    const feedbackTool = hookInput.tool;
    const feedbackOutcome = hookInput.status === "error" ? "error" : "result";
    const reject = (cause: QuarantineCause, classifierReason?: string | null) =>
      new ActionRejectedError({
        phase,
        tool: feedbackTool,
        outcome: feedbackOutcome,
        cause,
        classifierReason,
        testClassifier: !monitorMode && classifier === denyAllClassifier,
      });
    const checkpointToken = Symbol();
    const pending = { sessionID, cancelled: false };
    executingCheckpoints.set(checkpointToken, pending);
    let key: string | undefined;
    let call: Invocation | undefined;
    let released = false;
    let monitorStartAttempted = false;
    let monitorCall:
      { callID: string; tool: string; decision?: MonitorDecision; signal: AbortSignal } | undefined;
    const ensureCurrent = () => {
      if (startupFailure) throw reject("startup_failure");
      if (locallyQuarantined(sessionID)) throw reject("session_quarantined");
      if (closed || pending.cancelled || call?.cancelled) throw reject("cancelled");
      if (monitor?.isBroken) throw reject("monitor_failure");
    };
    const ensureToolAccess = async () => {
      try {
        if (await isQuarantined(sessionID)) throw reject("session_quarantined");
      } catch (error) {
        if (error instanceof ActionRejectedError) throw error;
        throw reject("quarantine_unavailable");
      }
      ensureCurrent();
    };
    try {
      // Detach before any SDK or approval await; bindings never follow mutations.
      const originalInput = snapshotToolEvent(hookInput);
      const originalOutput = jsonCopy(toolOutput(phase, originalInput));
      const inputDigest = digest(originalInput.input ?? null);
      // CodeMode reuses outer IDs. Keep every invocation, and report ambiguity.
      key = `${sessionID}\u0000${originalInput.messageID}\u0000${originalInput.id}\u0000${originalInput.tool}\u0000${inputDigest}`;
      const calls = preCalls.get(key) ?? [];
      call =
        phase === "pre_tool_call"
          ? { token: Symbol(key), observedAt, sessionID, cancelled: false }
          : calls[0];
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
        active.set(call!.token, call!);
      } else if (call) {
        calls.shift();
        if (!calls.length) {
          preCalls.delete(key);
          ambiguousPreCalls.delete(key);
        }
      }
      if (!startupResolved) await startup;
      ensureCurrent();
      await ensureToolAccess();
      if (monitor) {
        await monitor.checkSession(ctx, sessionID);
        const controller = new AbortController();
        monitorControllers.set(checkpointToken, { sessionID, controller });
        monitorCall = {
          callID: `${originalInput.messageID}:${originalInput.id}`,
          tool: monitor.normalizedTool(originalInput.tool),
          signal: controller.signal,
        };
        if (phase === "post_tool_call" && monitorDeniedCalls.has(monitorCall.callID)) {
          const reason = monitorDeniedCalls.get(monitorCall.callID)!;
          monitorDeniedCalls.delete(monitorCall.callID);
          // A pre refusal did not execute the tool. Quarantine any late error
          // instead of releasing unobserved harness text as an authorized result.
          await monitor.after(
            sessionID,
            monitorCall.callID,
            monitorCall.tool,
            originalInput.input,
            originalInput.status,
            originalOutput,
            monitorCall.signal,
          );
          throw reject("monitor_blocked", reason);
        }
      }
      const collected = await collector.collect({
        phase,
        hookInput: originalInput,
        hookOutput: originalOutput,
        preObservedAt,
        observedAt,
        gate: {
          state: "awaiting_classifier",
          scope_session_ids: [sessionID],
          reason: null,
        },
      });
      ensureCurrent();
      const request = bindRequest({
        contract: "opencode-plugin-classifier",
        contract_version: monitor ? "2.2.0" : "2.3.0",
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
            "Post hooks cover executed calls and their Tool.Error outcomes; pre-hook rejection, cancellation and runtime defects may have no post checkpoint.",
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
          classifier_unavailable: monitor
            ? "block_session_tree_and_request_abort"
            : "allow_with_harness_permissions",
          classifier_deny: monitor ? "block_or_require_monitor_approval" : "ask_user",
          user_allow: monitor
            ? "requires_monitor_approval_and_execution_permit"
            : "allow_once_for_bound_checkpoint",
          user_reject: monitor
            ? "block_session_tree_and_request_abort"
            : "reject_tool_call_or_withhold_result",
          user_no_response: monitor ? "keep_blocked" : "keep_checkpoint_pending",
          classifier_timeout_ms: monitor ? apiTimeoutMs : classifierTimeoutMs,
          ...(monitor
            ? { backend: "agent_monitor", monitor_run_id: monitor.monitorRunID }
            : { user_quarantine: "persist_session_and_descendants_chat_only" }),
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
      ensureCurrent();
      if (monitor && monitorCall && phase === "pre_tool_call") {
        let decision = await monitor.evaluate(
          sessionID,
          monitorCall.callID,
          monitorCall.tool,
          originalInput.input,
          monitorCall.signal,
        );
        await record(
          request,
          "plugin.monitor",
          decision.decision,
          decision.reason_codes.join(", "),
        );
        ensureCurrent();
        if (decision.decision === "REQUIRE_APPROVAL") {
          notify(
            `Agent Monitor: ожидается подтверждение ${decision.approval_id}. Используйте agent-monitor approve в доверенном терминале.`,
          );
          while (decision.decision === "REQUIRE_APPROVAL") {
            await delay(500, undefined, { signal: monitorCall.signal });
            await ensureToolAccess();
            decision = await monitor.evaluate(
              sessionID,
              monitorCall.callID,
              monitorCall.tool,
              originalInput.input,
              monitorCall.signal,
            );
          }
          await record(
            request,
            "plugin.monitor",
            decision.decision,
            decision.reason_codes.join(", "),
          );
          ensureCurrent();
        }
        if (decision.decision === "BLOCK") {
          monitor.recordDenied(monitorCall.callID);
          monitorDeniedCalls.set(monitorCall.callID, decision.reason_codes.join(", "));
          throw reject("monitor_blocked", decision.reason_codes.join(", "));
        }
        monitorCall.decision = decision;
      } else if (!monitor) {
        const response = await classify(request);
        await ensureToolAccess();
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
          await record(request, "plugin.classifier", response.decision!, response.reason);
          ensureCurrent();
          if (response.decision === "deny") {
            let decision: ApprovalDecision;
            try {
              await ensureToolAccess();
              const waiting = new AbortController();
              // Another workspace instance may quarantine an ancestor while this
              // form is pending. Release the wait as a refusal, without stopping
              // the model or requiring the user to answer obsolete cards.
              const watchQuarantine = async (): Promise<never> => {
                while (true) {
                  await delay(300, undefined, { signal: waiting.signal });
                  try {
                    await ensureToolAccess();
                  } catch (error) {
                    approvals.cancelSession([sessionID]);
                    throw error;
                  }
                }
              };
              try {
                decision = await Promise.race([
                  approvals.ask(request, response),
                  watchQuarantine(),
                ]);
              } finally {
                waiting.abort();
              }
            } catch (error) {
              // A UI failure is not a classifier outage and must never auto-allow.
              if (error instanceof ActionRejectedError) throw error;
              await ensureToolAccess();
              notify(error instanceof Error ? error.message : "Approval UI failed", "error");
              throw reject("confirmation_unavailable", response.reason);
            }
            if (decision === "quarantine") {
              ensureCurrent();
              // Latch synchronously before any I/O; pending siblings cannot race an
              // allow against this decision. Cancelling cards never aborts the LLM.
              quarantinedHere.add(sessionID);
              approvals.cancelSession(knownDescendants(sessionID));
              let saved = true;
              try {
                await quarantine.activate(sessionID);
              } catch {
                saved = false;
              }
              await record(
                request,
                "plugin.user_override",
                "deny",
                "Пользователь выбрал режим карантина: только общение, все инструменты заблокированы.",
                "session",
              );
              throw reject(saved ? "user_quarantined" : "quarantine_unavailable", response.reason);
            }
            await ensureToolAccess();
            if (decision === "reject") {
              await record(
                request,
                "plugin.user_override",
                "deny",
                "Пользователь отклонил этот checkpoint.",
              );
              throw reject("user_rejected", response.reason);
            }
            await record(
              request,
              "plugin.user_override",
              "allow",
              "Пользователь разрешил только этот checkpoint.",
            );
          }
        }
      }
      await ensureToolAccess();
      // Never release an approval for a different mutable value than displayed.
      const liveOutput = jsonCopy(toolOutput(phase, hookInput));
      if (
        digest(originalInput) !== digest(snapshotToolEvent(hookInput)) ||
        digest(originalOutput) !== digest(liveOutput)
      ) {
        throw reject("snapshot_changed");
      }
      if (monitor && monitorCall) {
        if (phase === "pre_tool_call") {
          monitorStartAttempted = true;
          await monitor.start(
            sessionID,
            monitorCall.callID,
            monitorCall.tool,
            originalInput.input,
            monitorCall.decision!,
            monitorCall.signal,
          );
          await record(
            request,
            "plugin.monitor",
            "started",
            "Single-use execution permit consumed",
          );
        } else {
          await monitor.after(
            sessionID,
            monitorCall.callID,
            monitorCall.tool,
            originalInput.input,
            originalInput.status,
            originalOutput,
            monitorCall.signal,
          );
          await record(
            request,
            "plugin.monitor",
            "result_recorded",
            "Completion reported; no post-result safety verdict",
          );
        }
        // Revalidate after HTTP/audit awaits, immediately before releasing the hook.
        ensureCurrent();
        if (
          monitorCall.signal.aborted ||
          digest(originalInput) !== digest(snapshotToolEvent(hookInput)) ||
          digest(originalOutput) !== digest(jsonCopy(toolOutput(phase, hookInput)))
        )
          throw reject("snapshot_changed");
      }
      await ensureToolAccess();
      if (
        digest(originalInput) !== digest(snapshotToolEvent(hookInput)) ||
        digest(originalOutput) !== digest(jsonCopy(toolOutput(phase, hookInput)))
      )
        throw reject("snapshot_changed");
      // No await between the final local guard and release.
      ensureCurrent();
      released = true;
    } catch (error) {
      // Policy refusals are complete decisions for one call. An integrity gap is
      // different: no further model/tool hooks may use this monitor instance.
      const quarantineRefusal =
        error instanceof ActionRejectedError &&
        ["session_quarantined", "user_quarantined"].includes(error.quarantineCause);
      if (
        monitor &&
        !(
          error instanceof ActionRejectedError &&
          (error.quarantineCause === "monitor_blocked" ||
            (quarantineRefusal && phase === "pre_tool_call" && !monitorStartAttempted))
        )
      ) {
        monitor.poison();
        for (const { controller } of monitorControllers.values()) controller.abort();
        notify(
          "Agent Monitor: выполнение остановлено из-за неполного состояния. Зарегистрируйте новую задачу и перезапустите плагин.",
          "error",
        );
        if (!(error instanceof ActionRejectedError) || quarantineRefusal)
          throw reject("monitor_failure");
      }
      if (error instanceof ActionRejectedError) throw error;
      notify(
        "Ошибка сбора или проверки контракта сенсора. Отменено только текущее действие.",
        "error",
      );
      notify(error instanceof Error ? error.message : "Sensor checkpoint failed", "error");
      throw reject("internal_failure");
    } finally {
      monitorControllers.delete(checkpointToken);
      executingCheckpoints.delete(checkpointToken);
      if (phase === "post_tool_call" || !released) {
        if (call) active.delete(call.token);
        if (key && phase === "pre_tool_call") {
          const remaining = (preCalls.get(key) ?? []).filter((item) => item !== call);
          if (remaining.length) preCalls.set(key, remaining);
          else {
            preCalls.delete(key);
            ambiguousPreCalls.delete(key);
          }
        }
      }
    }
  }

  async function after(event: Native): Promise<void> {
    const feedbackTool = event.tool;
    const feedbackOutcome = event.status === "error" ? "error" : "result";
    try {
      await checkpoint("post_tool_call", event);
    } catch (error) {
      // V2's after hook supports mutable results/errors, not typed failures.
      // Replace the entire value, including structured output and attachments.
      const message =
        error instanceof ActionRejectedError
          ? error.message
          : quarantineMessage({
              phase: "post_tool_call",
              tool: feedbackTool,
              outcome: feedbackOutcome,
              cause: "internal_failure",
            });
      if (event.status === "error") event.error = new ToolError({ message });
      else event.result = { content: message };
      notify(error instanceof Error ? error.message : "Передача результата отменена.");
    }
  }

  const hooks: Record<string, any> = {
    "tool.execute.before": (event: Native) => checkpoint("pre_tool_call", event),
    "tool.execute.after": after,
    event: (event: Native) => {
      collector.observeEvent(event);
      const sessionID = eventSession(event);
      if (!sessionID) return;
      // V2 emits the terminal execution event after its fiber is cancelled.
      // A harness cancellation invalidates current waits, not future user turns.
      if (
        [
          "session.deleted",
          "session.execution.interrupted",
          "session.execution.failed",
          "session.execution.succeeded",
        ].includes(event.type)
      ) {
        if (
          monitor &&
          ([...active.values()].some((call) => call.sessionID === sessionID) ||
            [...executingCheckpoints.values()].some(
              (checkpoint) => checkpoint.sessionID === sessionID,
            ))
        )
          monitor.poison();
        cancelCurrentCheckpoints(sessionID);
        for (const [token, call] of active) if (call.sessionID === sessionID) active.delete(token);
        // Retain cancelled pre entries until a late post can be recognized.
        if (event.type === "session.execution.succeeded" || event.type === "session.deleted") {
          for (const key of preCalls.keys())
            if (key.startsWith(`${sessionID}\u0000`)) {
              preCalls.delete(key);
              ambiguousPreCalls.delete(key);
            }
        }
      }
    },
    dispose: async () => {
      if (closed) return;
      closed = true;
      eventController.abort();
      monitor?.close();
      for (const { controller } of monitorControllers.values()) controller.abort();
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
      // These hooks observe context. Only a concrete tool checkpoint can refuse
      // work; a prior refusal must never block the user's next model request.
      if (!monitorMode && (closed || startupFailure)) return;
      const textOnly = async () => {
        if (!["context", "compaction", "generate"].includes(name)) return;
        let blocked = true;
        try {
          blocked = await isQuarantined(event.sessionID);
        } catch {
          notify("Не удалось проверить карантин: доступен только чат.");
        }
        if (blocked) {
          event.tools = {};
          const reminder =
            "Режим карантина: доступно только общение. Все инструменты отключены; отвечайте текстом без попыток вызвать инструменты.";
          if (
            Array.isArray(event.system) &&
            !event.system.some((part: Native) => part.type === "text" && part.text === reminder)
          )
            event.system.push({ type: "text", text: reminder });
        }
      };
      await textOnly();
      if (monitorMode) {
        if (!startupResolved) await startup;
        if (closed || startupFailure || !monitor)
          throw new Error("Agent Monitor is not ready; model execution blocked");
        try {
          await monitor.checkSession(ctx, event.sessionID);
          if (name === "prompt") {
            if (event.prompt?.files?.length)
              throw new Error("Prompt attachments are unsupported in monitor mode");
            await monitor.content(
              event.sessionID,
              id("event"),
              "user",
              event.prompt?.text ?? "",
              eventController.signal,
            );
          } else if (name === "context") {
            await monitor.content(
              event.sessionID,
              id("event"),
              "repository",
              JSON.stringify({ system: event.system, messages: event.messages }),
              eventController.signal,
            );
          }
          await collector.observeHook(`session.${name}`, event);
          if (monitor.isBroken)
            throw new Error("Monitor state incomplete; model execution blocked");
        } catch (error) {
          monitor.poison();
          throw error;
        }
      } else {
        if (closed || startupFailure) return;
        try {
          await collector.observeHook(`session.${name}`, event);
        } catch {
          notify("Не удалось записать наблюдение контекста модели.", "error");
        }
      }
      await textOnly();
    };
  }
  hooks["permission.evaluate"] = async (event: Native) => {
    if (monitorMode) {
      if (!startupResolved) await startup;
      if (closed || startupFailure || !monitor)
        throw new Error("Agent Monitor is not ready; execution blocked");
      await monitor.checkSession(ctx, event.sessionID);
      if (["shell", "subagent", "execute", "external_directory"].includes(event.action)) {
        event.effect = "deny";
        event.message = "Disabled by Agent Monitor";
      }
    }
    if (closed || startupFailure) return;
    try {
      await collector.observeHook("permission.evaluate", event);
    } catch {
      notify("Не удалось записать наблюдение разрешения.", "error");
    }
    // Never weaken the configured harness permission policy.
  };
  hooks["shell.create.before"] = async (event: Native) => {
    if (monitorMode) throw new Error("Agent Monitor: unmediated shells are disabled");
    if (closed || startupFailure) return;
    // This hook has no session identity. Never guess one from concurrent activity.
    await collector.observeHook("shell.create.before", event);
  };

  // Register the enforcement surface before initializing the audit and native UI.
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
    if (monitorMode)
      monitor = dependencies.monitor ?? (await MonitorBackend.create(ctx, options, apiTimeoutMs));
    else await approvals.start();
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
        monitor?.poison();
        // Loss of cancellation observation must not leave a stale approval alive.
        for (const sessionID of new Set(
          [...active.values(), ...executingCheckpoints.values()].map((item) => item.sessionID),
        ))
          cancelCurrentCheckpoints(sessionID);
        notify(
          monitorMode
            ? "Поток событий OpenCode недоступен; Agent Monitor блокирует продолжение."
            : "Поток событий OpenCode недоступен. Сенсор отклоняет действия; текстовые сообщения доступны.",
          "error",
        );
      }
    })();
  } catch (error) {
    startupFailure = error;
    notify(
      `${monitorMode ? "Agent Monitor не запустился; продолжение заблокировано" : "Сенсор не запустился; инструменты недоступны, текстовые сообщения доступны"}: ${
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
      monitor
        ? "Agent Monitor подключён: политика, разрешения и execution permits контролируются сервисом."
        : options.backend === "jev"
          ? "JEV подключён через Eliza: полный доступный контекст; карантин при вероятности атаки >80%."
          : "Заглушка классификатора включена: каждый pre/post требует подтверждения внутри OpenCode. Браузерная панель не используется.",
      "info",
    );
  return hooks;
}
