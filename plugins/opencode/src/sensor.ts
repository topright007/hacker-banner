import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ApprovalServer } from "./approval-server.js";
import { AuditLog } from "./audit.js";
import { denyAllClassifier, type Classifier } from "./classifier.js";
import { ContextCollector } from "./collector.js";
import { ActionRejectedError, type QuarantineCause } from "./gates.js";
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
  const audit = new AuditLog(stateDirectory);
  const classifier = dependencies.classifier ?? denyAllClassifier;
  let sequence = 0;
  let closed = false;
  type Invocation = { sessionID: string; observedAt: number; cancelled: boolean };
  const active = new Map<string, Invocation>();
  const executingCheckpoints = new Map<symbol, { sessionID: string; cancelled: boolean }>();
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

  function cancelCurrentCheckpoints(sessionID: string): void {
    // Only invalidate work already in flight, never future user turns.
    for (const checkpoint of executingCheckpoints.values())
      if (checkpoint.sessionID === sessionID) checkpoint.cancelled = true;
    for (const call of active.values()) if (call.sessionID === sessionID) call.cancelled = true;
    approvals.cancelSession([sessionID]);
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
      scope: "call",
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
    const observedAt = Date.now();
    const sessionID = hookInput.sessionID as string;
    // Preserve the tool identity even if another hook mutates the live input.
    const tool = hookInput.tool;
    const rejection = (cause: QuarantineCause, classifierReason?: string | null) =>
      new ActionRejectedError({
        phase,
        tool,
        cause,
        classifierReason,
        testClassifier: classifier === denyAllClassifier,
      });
    const checkpointToken = Symbol();
    const pending = { sessionID, cancelled: false };
    executingCheckpoints.set(checkpointToken, pending);
    let key: string | undefined;
    let call: Invocation | undefined;
    let released = false;
    const ensureCurrent = () => {
      if (closed || pending.cancelled || call?.cancelled) throw rejection("cancelled");
    };
    try {
      // Detach before the first await; an approval binds this exact input/output.
      const originalInput = jsonCopy(hookInput);
      const originalOutput = hookOutput === undefined ? null : jsonCopy(hookOutput);
      key = `${sessionID}\u0000${originalInput.callID}`;
      call =
        phase === "pre_tool_call" ? { sessionID, observedAt, cancelled: false } : active.get(key);
      if (phase === "pre_tool_call") active.set(key, call!);
      ensureCurrent();
      const collected = await collector.collect({
        phase,
        hookInput: originalInput as { tool: string; sessionID: string; callID: string; args?: any },
        hookOutput: originalOutput,
        preObservedAt: call?.observedAt ?? null,
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
        contract_version: "1.1.0",
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
          user_reject: "reject_tool_call_or_withhold_result",
          user_no_response: "keep_checkpoint_pending",
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
      ensureCurrent();
      const response = await classify(request);
      ensureCurrent();
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
          let decision: "allow" | "reject";
          try {
            decision = await approvals.ask(request, response);
          } catch {
            // A UI failure is not a classifier outage and must never auto-allow.
            ensureCurrent();
            throw rejection("confirmation_unavailable", response.reason);
          }
          ensureCurrent();
          if (decision === "reject") {
            await record(
              request,
              "plugin.user_override",
              "deny",
              "Пользователь отклонил этот checkpoint.",
            );
            throw rejection("user_rejected", response.reason);
          }
          await record(
            request,
            "plugin.user_override",
            "allow",
            "Пользователь разрешил только этот checkpoint.",
          );
        }
      }
      ensureCurrent();
      // Never release an approval for a different mutable value than displayed.
      const liveOutput = hookOutput === undefined ? null : jsonCopy(hookOutput);
      if (
        digest(originalInput) !== digest(jsonCopy(hookInput)) ||
        digest(originalOutput) !== digest(liveOutput)
      ) {
        throw rejection("snapshot_changed");
      }
      released = true;
    } catch (error) {
      if (error instanceof ActionRejectedError) throw error;
      notify(
        "Ошибка сбора или проверки контракта сенсора. Отменено только текущее действие.",
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
        /* Logging cannot authorize the failed checkpoint. */
      }
      throw rejection("internal_failure");
    } finally {
      executingCheckpoints.delete(checkpointToken);
      if (key && (phase === "post_tool_call" || !released) && active.get(key) === call)
        active.delete(key);
    }
  }

  async function after(data: Native, output: Native | undefined): Promise<void> {
    const tool = data.tool;
    try {
      await checkpoint("post_tool_call", data, output);
    } catch (error) {
      if (!output || typeof output !== "object") {
        // V1 has special paths with no mutable result: never pretend we redacted it.
        throw new ActionRejectedError({
          phase: "post_tool_call",
          tool,
          cause: "unmodifiable_result",
        });
      }
      const message =
        error instanceof ActionRejectedError
          ? error.message
          : new ActionRejectedError({ phase: "post_tool_call", tool, cause: "internal_failure" })
              .message;
      // V1 passes the original object by reference. Clear every field, including
      // MCP content/structuredContent/_meta and builtin attachments/metadata.
      // Populate both safe shapes because MCP extensions can mimic builtin keys.
      for (const key of Reflect.ownKeys(output)) {
        if (!Reflect.deleteProperty(output, key))
          throw new ActionRejectedError({
            phase: "post_tool_call",
            tool,
            cause: "redaction_failure",
          });
      }
      Object.assign(output, {
        title: "Карантин: результат скрыт сенсором",
        output: message,
        metadata: {},
        attachments: [],
        content: [{ type: "text", text: message }],
        isError: true,
      });
      notify(message);
    }
  }

  const hooks: Record<string, any> = {
    "tool.execute.before": (data: Native, output: Native) =>
      checkpoint("pre_tool_call", data, output),
    "tool.execute.after": after,
    "tool.definition": async (data: Native, output: Native) =>
      collector.observeDefinition(data, output),
    event: async ({ event }: { event: Native }) => {
      collector.observeEvent(event);
      const sessionID = eventSession(event);
      if (!sessionID) return;
      const part = event.properties?.part;
      if (part?.type === "tool" && ["completed", "error"].includes(part.state?.status)) {
        const key = `${sessionID}\u0000${part.callID}`;
        // An abort can persist an error before an abort-ignoring tool returns.
        // Keep the invocation so its late post cannot reopen an approval.
        // Successful special paths may also persist completion before post.
        const call = active.get(key);
        if (call && part.state.status === "error") call.cancelled = true;
      }
      if (
        event.type === "session.deleted" ||
        event.type === "session.error" ||
        (event.type === "session.status" && event.properties?.status?.type === "idle")
      ) {
        // Cancel current waits even when native part updates already removed the
        // in-flight tool. An idle child never cancels its parent's checkpoint.
        cancelCurrentCheckpoints(sessionID);
        if (event.type === "session.deleted")
          for (const [key, call] of active) if (call.sessionID === sessionID) active.delete(key);
      }
    },
    dispose: async () => {
      if (closed) return;
      closed = true;
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
      if (closed) return;
      // Context hooks only observe. A refused action must not block a later turn.
      try {
        collector.observeHook(name, data, output);
      } catch {
        notify("Не удалось записать наблюдение контекста модели.", "error");
      }
    };
  }
  notify(
    `Заглушка классификатора включена: каждый pre/post требует подтверждения. Локальное управление: ${join(stateDirectory, "control.json")}`,
    "info",
  );
  return hooks;
}
