import { createHash } from "node:crypto";
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
  stateDirectory?: string;
  openBrowser?: boolean;
  apiTimeoutMs?: number;
  classifierTimeoutMs?: number;
}

export interface SensorInput {
  client: any;
  project: Native;
  directory: string;
  worktree: string;
}

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
  const p = event.properties ?? {};
  return (
    p.sessionID ??
    p.part?.sessionID ??
    p.info?.sessionID ??
    (event.type?.startsWith("session.") ? p.info?.id : undefined)
  );
}

function observationSession(name: string, input: Native, output: Native): string | undefined {
  if (typeof input.sessionID === "string") return input.sessionID;
  if (name === "experimental.chat.messages.transform") {
    const ids = new Set<string>(
      (output.messages ?? [])
        .map((m: Native) => m.info?.sessionID)
        .filter((v: unknown) => typeof v === "string"),
    );
    if (ids.size === 1) return [...ids][0];
  }
  return undefined;
}

export async function createSensor(
  input: SensorInput,
  options: SensorOptions = {},
  dependencies: SensorDependencies = {},
) {
  const instanceID = id("instance");
  const runID = id("run");
  const apiTimeoutMs = milliseconds(options.apiTimeoutMs, 5000);
  const classifierTimeoutMs = milliseconds(options.classifierTimeoutMs, 3000);
  const workspaceHash = createHash("sha256").update(input.directory).digest("hex").slice(0, 16);
  if (
    options.stateDirectory !== undefined &&
    (typeof options.stateDirectory !== "string" || !isAbsolute(options.stateDirectory))
  ) {
    throw new Error("Sensor stateDirectory must be an absolute path");
  }
  if (options.openBrowser !== undefined && typeof options.openBrowser !== "boolean")
    throw new Error("Sensor openBrowser must be boolean");
  const stateDirectory = options.stateDirectory
    ? resolve(options.stateDirectory)
    : join(homedir(), ".local", "state", "opencode-sensor", workspaceHash, instanceID);
  const collector = new ContextCollector({ ...input, apiTimeoutMs });
  const gates = new SessionGates(collector.knownParents);
  const audit = new AuditLog(stateDirectory);
  const classifier = dependencies.classifier ?? denyAllClassifier;
  let sequence = 0;
  let closed = false;
  const preTimes = new Map<string, number>();
  const active = new Map<string, string>();
  const executingCheckpoints = new Map<symbol, string>();
  const notices = new Set<Promise<void>>();

  async function notice(
    message: string,
    variant: "warning" | "error" | "info" = "warning",
  ): Promise<void> {
    try {
      await input.client.tui.showToast({
        body: { title: "OpenCode Sensor", message, variant, duration: 15000 },
        signal: AbortSignal.timeout(apiTimeoutMs),
      });
    } catch {
      // A headless run may have no TUI. The authenticated local UI and audit still work.
    }
  }

  function notify(message: string, variant: "warning" | "error" | "info" = "warning"): void {
    const pending = notice(message, variant);
    notices.add(pending);
    void pending.finally(() => notices.delete(pending));
  }

  const approvals =
    dependencies.approvals ??
    new ApprovalServer({
      stateDirectory,
      openBrowser: options.openBrowser ?? true,
      onNotice: (message) => notice(message),
    });
  await audit.start();
  await approvals.start();

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
          input.client.session.abort({
            path: { id: session },
            query: { directory: input.directory },
            signal: AbortSignal.timeout(apiTimeoutMs),
          }),
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

  async function checkpoint(
    phase: Phase,
    hookInput: Native,
    hookOutput: Native | undefined,
  ): Promise<void> {
    // Deep-copy at ingress, before any SDK/approval awaits; tool inputs/results
    // are mutable in the V1 plugin chain.
    const observedAt = Date.now();
    const originalInput = jsonCopy(hookInput);
    const originalOutput = hookOutput === undefined ? null : jsonCopy(hookOutput);
    const sessionID = originalInput.sessionID as string;
    const key = `${sessionID}\u0000${originalInput.callID}`;
    if (phase === "pre_tool_call") preTimes.set(key, observedAt);
    active.set(key, sessionID);
    const checkpointToken = Symbol(key);
    executingCheckpoints.set(checkpointToken, sessionID);
    try {
      await gates.wait(sessionID);
      const collected = await collector.collect({
        phase,
        hookInput: originalInput as { tool: string; sessionID: string; callID: string; args?: any },
        hookOutput: originalOutput,
        preObservedAt: preTimes.get(key) ?? null,
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
        contract_version: "1.0.0",
        request_id: id("req"),
        phase,
        harness: { name: "opencode", version: "1.18.11", plugin_api: "v1" },
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
          history_transport: "full",
          limitations: [
            "API snapshots span time; already-running sibling tools can finish while this hook waits.",
            "Context hooks are independent observations, not the exact final provider request.",
            "Later plugins may mutate the checked output. Run this sensor last and restrict other plugins.",
            "Session/event journal starts at plugin attachment; ordinary tool errors may skip the post hook.",
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
      const liveOutput = hookOutput === undefined ? null : jsonCopy(hookOutput);
      if (
        digest(originalInput) !== digest(jsonCopy(hookInput)) ||
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
        try {
          await input.client.app.log({
            body: {
              service: "opencode-sensor",
              level: "error",
              message: error instanceof Error ? error.message : "Sensor checkpoint failed",
            },
            signal: AbortSignal.timeout(apiTimeoutMs),
          });
        } catch {
          /* Logging is diagnostic and must not undo the block. */
        }
      }
      throw error;
    } finally {
      executingCheckpoints.delete(checkpointToken);
      if (phase === "post_tool_call" || gates.isBlocked(sessionID)) {
        active.delete(key);
        preTimes.delete(key);
      }
    }
  }

  const hooks: Record<string, any> = {
    "tool.execute.before": (data: Native, output: Native) =>
      checkpoint("pre_tool_call", data, output),
    "tool.execute.after": (data: Native, output: Native | undefined) =>
      checkpoint("post_tool_call", data, output),
    "tool.definition": async (data: Native, output: Native) =>
      collector.observeDefinition(data, output),
    event: async ({ event }: { event: Native }) => {
      collector.observeEvent(event);
      const sessionID = eventSession(event);
      if (!sessionID) return;
      const part = event.properties?.part;
      if (part?.type === "tool" && ["completed", "error"].includes(part.state?.status)) {
        const key = `${sessionID}\u0000${part.callID}`;
        active.delete(key);
        preTimes.delete(key);
      }
      if (
        (event.type === "session.deleted" ||
          event.type === "session.error" ||
          (event.type === "session.status" && event.properties?.status?.type === "idle")) &&
        [...active.values(), ...executingCheckpoints.values()].includes(sessionID)
      ) {
        // Cancellation can arrive while collecting data, before the UI has a
        // pending card. Latch it now; cancelling only existing cards loses it.
        // Match the exact session: a normally completed child must not cancel
        // the parent's still-running task tool.
        stop(sessionID);
      }
    },
    dispose: async () => {
      if (closed) return;
      closed = true;
      gates.close();
      await approvals.close();
      await audit.flush();
      await Promise.allSettled([...notices]);
    },
  };
  for (const name of [
    "chat.message",
    "experimental.chat.messages.transform",
    "experimental.chat.system.transform",
    "chat.params",
    "chat.headers",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "command.execute.before",
    "experimental.text.complete",
    "shell.env",
  ]) {
    hooks[name] = async (data: Native, output: Native) => {
      collector.observeHook(name, data, output);
      const sessionID = observationSession(name, data, output);
      if (sessionID) await gates.wait(sessionID);
    };
  }
  notify(
    `Заглушка классификатора включена: каждый pre/post требует подтверждения. Локальное управление: ${join(stateDirectory, "control.json")}`,
    "info",
  );
  return hooks;
}
