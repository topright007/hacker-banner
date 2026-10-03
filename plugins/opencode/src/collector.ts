import { createHash, randomUUID } from "node:crypto";
import {
  cloneJson,
  object,
  pick,
  safeAgent,
  safeConfiguration,
  safeHook,
  safeMcp,
  safeModel,
} from "./sanitize.js";

type AnyObject = Record<string, any>;
type Envelope = {
  availability: "observed" | "partial" | "not_observed" | "collection_error";
  source: string;
  collected_at_ms: number | null;
  reason: string | null;
  value: any;
};
type ApiResult = { value?: any; response?: any; error?: string; at: number };
export type CollectInput = {
  phase: "pre_tool_call" | "post_tool_call";
  hookInput: { tool: string; sessionID: string; callID: string; args?: any };
  hookOutput: any;
  preObservedAt: number | null;
  observedAt: number;
  gate: { state: string; scope_session_ids: string[]; reason: string | null };
};

const str = (x: any): string | null => (typeof x === "string" && x.length > 0 ? x : null);
const ms = (x: any): number | null => (Number.isSafeInteger(x) && x >= 0 ? x : null);
const observed = (source: string, value: any, at = Date.now()): Envelope => ({
  availability: "observed",
  source,
  collected_at_ms: at,
  reason: null,
  value,
});
const absent = (source: string, reason: string): Envelope => ({
  availability: "not_observed",
  source,
  collected_at_ms: null,
  reason,
  value: null,
});
const failed = (source: string, result: ApiResult): Envelope => ({
  availability: "collection_error",
  source,
  collected_at_ms: result.at,
  reason: result.error ?? "No data returned",
  value: null,
});
const envelope = (source: string, result: ApiResult): Envelope =>
  result.error ? failed(source, result) : observed(source, result.value, result.at);
const modelIdentity = (info: any = {}) => ({
  provider_id: str(info.providerID ?? info.provider_id ?? info.model?.providerID),
  model_id: str(info.modelID ?? info.model_id ?? info.id ?? info.model?.modelID),
  variant: typeof info.variant === "string" ? info.variant : null,
});
const identity = (message: any, source = "session.messages") => ({
  agent_name: typeof message?.info?.agent === "string" ? message.info.agent : null,
  model:
    message?.info?.role === "user"
      ? modelIdentity({ ...message.info.model, variant: message.info.variant })
      : modelIdentity({
          modelID: message?.info?.modelID,
          providerID: message?.info?.providerID,
          variant: message?.info?.variant,
        }),
  source,
  message_id: str(message?.info?.id),
});

function normalizedResult(value: any): AnyObject {
  return {
    format:
      value === undefined || value === null
        ? "missing"
        : Array.isArray(value.content)
          ? "mcp_call_tool_result"
          : "builtin_output",
    native: value == null ? null : cloneJson(value),
    normalized: {
      title: typeof value?.title === "string" ? value.title : null,
      output: typeof value?.output === "string" ? value.output : null,
      metadata: object(value?.metadata) ? cloneJson(value.metadata) : null,
      attachments: Array.isArray(value?.attachments) ? cloneJson(value.attachments) : null,
      content: Array.isArray(value?.content) ? cloneJson(value.content) : null,
      structured_content: value?.structuredContent ?? null,
      is_error: typeof value?.isError === "boolean" ? value.isError : null,
    },
    missing_reason:
      value == null ? "The post hook supplied no result (possible special subtask path)." : null,
  };
}

/** Collects only public V1 SDK/hook evidence. No provider proxy, filesystem crawl or credential access. */
export class ContextCollector {
  readonly knownParents = new Map<string, string | null>();
  private readonly startedAt = Date.now();
  private sequence = 0;
  private readonly hooks: AnyObject[] = [];
  private readonly events: AnyObject[] = [];
  private readonly approvals: AnyObject[] = [];
  private readonly definitions = new Map<string, AnyObject>();
  private readonly pendingPermissions = new Map<string, AnyObject>();
  private readonly captureErrors: { source: string; session_id: string | null; message: string }[] =
    [];

  constructor(
    private readonly options: {
      client: any;
      project: any;
      directory: string;
      worktree: string;
      apiTimeoutMs: number;
    },
  ) {}

  relevantSessionIds(sessionID: string): string[] {
    let root = sessionID;
    const seen = new Set<string>();
    while (this.knownParents.get(root) && !seen.has(root)) {
      seen.add(root);
      root = this.knownParents.get(root)!;
    }
    const ids = new Set([root, sessionID]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, parent] of this.knownParents)
        if (parent && ids.has(parent) && !ids.has(id)) {
          ids.add(id);
          changed = true;
        }
    }
    return [...ids];
  }

  observeHook(name: string, input: any, output: any): void {
    try {
      const snapshot = safeHook(name, input ?? {}, output);
      let sessionID = str(input?.sessionID);
      let correlation = sessionID ? "direct" : "unknown";
      if (!sessionID && Array.isArray(output?.messages)) {
        const ids = new Set<string>(
          output.messages.map((x: any) => str(x.info?.sessionID)).filter(Boolean),
        );
        if (ids.size === 1) {
          sessionID = [...ids][0]!;
          correlation = "derived_from_message_session_ids";
        }
      }
      this.hooks.push({
        observation_id: randomUUID(),
        sequence: ++this.sequence,
        observed_at_ms: Date.now(),
        hook: name,
        session_id: sessionID,
        message_id: str(input?.messageID ?? input?.message?.id ?? output?.message?.id),
        hook_call_id: str(input?.callID),
        agent_name: typeof input?.agent === "string" ? input.agent : null,
        model: input?.model ? modelIdentity(input.model) : null,
        correlation: { session: correlation, current_call: "unknown" },
        input: snapshot.input,
        output: snapshot.output,
        redaction_applied: snapshot.redacted,
      });
    } catch (error) {
      this.captureErrors.push({
        source: name,
        session_id: str(input?.sessionID),
        message: error instanceof Error ? error.message : "Snapshot failed",
      });
    }
  }

  observeDefinition(input: any, output: any): void {
    try {
      this.cacheDefinition(input?.toolID, output, "tool.definition", null);
    } catch (error) {
      this.captureErrors.push({
        source: "tool.definition",
        session_id: null,
        message: error instanceof Error ? error.message : "Definition snapshot failed",
      });
    }
  }

  private cacheDefinition(
    toolID: any,
    output: any,
    source: "tool.definition" | "sdk.tool.list",
    model: any,
  ): void {
    if (!str(toolID)) return;
    // Effect/Zod parameters are not JSON schema. SDK parameters are explicitly serialized JSON schema.
    const schema = source === "sdk.tool.list" ? output?.parameters : output?.jsonSchema;
    const inputSchema = typeof schema === "boolean" || object(schema) ? cloneJson(schema) : null;
    const native = {
      ...pick(output, ["id", "description"]),
      ...(inputSchema !== null
        ? { [source === "sdk.tool.list" ? "parameters" : "jsonSchema"]: inputSchema }
        : {}),
    };
    const key = `${source}:${toolID}:${JSON.stringify(model)}`;
    this.definitions.set(key, {
      definition_id: createHash("sha256")
        .update(key + JSON.stringify(native))
        .digest("hex"),
      tool_id: toolID,
      origin: "unknown",
      description: typeof output?.description === "string" ? output.description : null,
      input_schema: inputSchema,
      schema_status: inputSchema === null ? "unavailable" : "json_schema_observed",
      source,
      scope: source === "sdk.tool.list" ? "default_agent_registry" : "registry_stage",
      collected_at_ms: Date.now(),
      model_filter: model,
      model_visible_exact: false,
      native_json: native,
    });
  }

  observeEvent(event: any): void {
    try {
      const native = cloneJson(event);
      const p = native.properties ?? native.data ?? {};
      const sessionID = str(
        p.sessionID ??
          p.info?.sessionID ??
          p.part?.sessionID ??
          (native.type?.startsWith("session.") ? p.info?.id : null),
      );
      if (native.type === "session.created" || native.type === "session.updated") {
        if (str(p.info?.id)) this.knownParents.set(p.info.id, str(p.info.parentID));
      }
      this.events.push({
        event_id: str(native.id) ?? randomUUID(),
        sequence: ++this.sequence,
        observed_at_ms: Date.now(),
        session_id: sessionID,
        native,
      });
      if (native.type === "permission.asked" || native.type === "permission.updated") {
        if (str(p.id)) this.pendingPermissions.set(p.id, native);
      }
      if (native.type === "permission.replied") {
        const id = str(p.requestID ?? p.permissionID);
        const asked = id ? this.pendingPermissions.get(id) : null;
        const details = asked?.properties ?? asked?.data ?? {};
        if (id) this.pendingPermissions.delete(id);
        const decision = p.reply ?? p.response;
        if (sessionID && ["once", "always", "reject", "allow", "deny"].includes(decision))
          this.recordApproval({
            source: "harness.permission_event",
            session_id: sessionID,
            permission_request_id: id,
            tool_call_id: details.tool?.callID ?? details.callID ?? null,
            decision,
            scope: "permission_patterns",
            native,
          });
      }
    } catch (error) {
      this.captureErrors.push({
        source: "event",
        session_id: null,
        message: error instanceof Error ? error.message : "Event snapshot failed",
      });
    }
  }

  recordApproval(item: any): void {
    this.approvals.push(
      cloneJson({
        decision_id: item.decision_id ?? randomUUID(),
        source: item.source,
        session_id: item.session_id,
        tool_call_id: item.tool_call_id ?? null,
        hook_call_id: item.hook_call_id ?? null,
        classifier_request_id: item.classifier_request_id ?? null,
        permission_request_id: item.permission_request_id ?? null,
        phase: item.phase ?? null,
        decision: item.decision,
        reason: item.reason ?? null,
        scope: item.scope ?? "call",
        binding_digest: item.binding_digest ?? null,
        decided_at_ms: item.decided_at_ms ?? Date.now(),
        native: item.native ?? null,
      }),
    );
  }

  private async api(path: string, args: any = {}): Promise<ApiResult> {
    const parts = path.split(".");
    let receiver = this.options.client;
    for (const part of parts.slice(0, -1)) receiver = receiver?.[part];
    const method = receiver?.[parts.at(-1)!];
    return this.invoke(() => {
      if (typeof method !== "function") throw new Error(`SDK method ${path} is unavailable`);
      return { receiver, method, args };
    });
  }

  private async route(url: string): Promise<ApiResult> {
    return this.invoke(() => {
      const receiver = this.options.client?._client;
      if (typeof receiver?.get !== "function")
        throw new Error(`Authenticated SDK transport unavailable for ${url}`);
      return { receiver, method: receiver.get, args: { url } };
    });
  }

  private async invoke(
    prepare: () => { receiver: any; method: any; args: any },
  ): Promise<ApiResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const { receiver, method, args } = prepare();
      const result: any = await Promise.race([
        Promise.resolve().then(() =>
          method.call(receiver, {
            ...args,
            query: { directory: this.options.directory, ...args.query },
            signal: controller.signal,
          }),
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => {
              controller.abort();
              reject(new Error("OpenCode API timeout"));
            },
            Math.max(1, this.options.apiTimeoutMs),
          );
        }),
      ]);
      if (result?.error)
        throw new Error(
          typeof result.error === "string" ? result.error : "OpenCode API returned an error",
        );
      if (result?.response?.ok === false)
        throw new Error(`OpenCode API HTTP ${result.response.status}`);
      const value = result && Object.hasOwn(result, "data") ? result.data : result;
      if (value === undefined || value === null) throw new Error("OpenCode API returned no data");
      return { value: cloneJson(value), response: result?.response, at: Date.now() };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "OpenCode API failed",
        at: Date.now(),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async history(id: string): Promise<Envelope> {
    const messages: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let last: ApiResult = { at: Date.now() };
    do {
      last = await this.api("session.messages", {
        path: { id },
        query: cursor ? { limit: 100, before: cursor } : { limit: 0 },
      });
      if (last.error || !Array.isArray(last.value)) {
        const reason = last.error ?? "Expected a native message array";
        if (!messages.length) return failed("session.messages", { ...last, error: reason });
        return {
          ...observed("session.messages", this.historyValue(messages, false), last.at),
          availability: "partial",
          reason,
        };
      }
      messages.unshift(...last.value);
      cursor = last.response?.headers?.get?.("x-next-cursor") ?? undefined;
      if (cursor && cursors.has(cursor))
        return {
          ...observed("session.messages", this.historyValue(messages, false), last.at),
          availability: "partial",
          reason: "Repeated pagination cursor",
        };
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return observed("session.messages", this.historyValue(messages, true), last.at);
  }

  private historyValue(messages: any[], complete: boolean): AnyObject {
    const unique = [...new Map(messages.map((message) => [message.info?.id, message])).values()];
    return {
      format: "opencode.messages.v1",
      scope: "all_available_persisted_messages",
      messages: unique,
      pagination_exhausted: complete,
      redaction_applied: false,
      first_message_id: str(unique[0]?.info?.id),
      last_message_id: str(unique.at(-1)?.info?.id),
    };
  }

  async collect(input: CollectInput): Promise<{
    current_call: any;
    context: any;
    coverage: any;
    collection_started_at_ms: number;
    collection_finished_at_ms: number;
  }> {
    const start = Date.now();
    // Everything used after await must be detached from mutable hook objects.
    const checkpoint = cloneJson(input);
    const sessionID = checkpoint.hookInput.sessionID;
    const callID = checkpoint.hookInput.callID;
    const infos = new Map<string, Envelope>();
    const errors: AnyObject[] = [];
    const loadInfo = async (id: string) => {
      if (infos.has(id)) return infos.get(id)!;
      const result = await this.api("session.get", { path: { id } });
      if (!result.error && (!object(result.value) || result.value.id !== id))
        result.error = "Session API returned mismatched identity";
      const value = envelope("session.get", result);
      infos.set(id, value);
      if (!result.error) this.knownParents.set(id, str(result.value.parentID));
      return value;
    };
    const commonPromise = Promise.all([
      this.api("config.get"),
      this.api("app.agents"),
      this.api("session.status"),
      this.api("config.providers"),
      this.api("mcp.status"),
      this.api("path.get"),
      this.api("vcs.get"),
      this.route("/skill"),
      this.route("/experimental/resource"),
      this.route("/permission"),
    ]);
    let root = sessionID;
    let rootResolved = false;
    const ancestors = new Set<string>();
    while (!ancestors.has(root)) {
      ancestors.add(root);
      const info = await loadInfo(root);
      if (!info.value) break;
      const parent = str(info.value.parentID);
      if (!parent) {
        rootResolved = true;
        break;
      }
      root = parent;
    }
    const children = new Map<string, Envelope>();
    const queue = [root, ...ancestors];
    const discovered = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (discovered.has(id)) continue;
      discovered.add(id);
      await loadInfo(id);
      const fetched = await this.api("session.children", { path: { id } });
      if (!fetched.error && !Array.isArray(fetched.value))
        fetched.error = "Expected a child session array";
      const result = envelope("session.children", fetched);
      children.set(id, result);
      for (const child of result.value ?? []) {
        if (!str(child.id) || child.parentID !== id) {
          errors.push({
            source: "session.children",
            code: "invalid_lineage",
            message: "Child session identity or parent did not match the requested tree",
          });
          continue;
        }
        this.knownParents.set(child.id, id);
        if (!discovered.has(child.id)) queue.push(child.id);
      }
    }
    const depth = (id: string): number | null => {
      let count = 0;
      const seen = new Set<string>();
      while (id !== root) {
        if (seen.has(id)) return null;
        seen.add(id);
        const parent = this.knownParents.get(id);
        if (!parent) return null;
        id = parent;
        count++;
      }
      return rootResolved ? count : null;
    };
    const [config, agents, statuses, providers, mcp, paths, vcs, skills, resources, permissions] =
      await commonPromise;
    for (const result of [agents, skills, permissions])
      if (!result.error && !Array.isArray(result.value))
        result.error = "Expected an array from OpenCode API";
    for (const result of [config, statuses, providers, mcp, paths, vcs, resources])
      if (!result.error && !object(result.value))
        result.error = "Expected an object from OpenCode API";
    const sessions = await Promise.all(
      [...discovered].map(async (id) => {
        const [history, todo, diff] = await Promise.all([
          this.history(id),
          this.api("session.todo", { path: { id } }),
          this.api("session.diff", { path: { id } }),
        ]);
        const info = infos.get(id)!;
        const messages = history.value?.messages ?? [];
        const last = messages.at(-1);
        const lastFinal = messages.findLast(
          (m: any) =>
            m.info?.role === "assistant" &&
            m.info?.finish &&
            !["tool-calls", "unknown"].includes(m.info.finish) &&
            m.info?.time?.completed,
        );
        return {
          session_id: id,
          parent_session_id: str(info.value?.parentID),
          parent_relation: info.value
            ? info.value.parentID
              ? "observed"
              : "root_confirmed"
            : "unknown",
          child_session_ids: (children.get(id)?.value ?? [])
            .filter((x: any) => x.parentID === id)
            .map((x: any) => x.id),
          children_complete: children.get(id)?.availability === "observed",
          delegation_depth: depth(id),
          identity: identity(last),
          delegated_prompt: absent("task/subtask", "No linked delegation prompt observed"),
          native_info: info,
          history,
          status: statuses.error
            ? failed("session.status", statuses)
            : statuses.value?.[id]
              ? observed("session.status", statuses.value[id], statuses.at)
              : absent("session.status", "No status entry returned for this session"),
          timestamps: {
            created_at_ms: ms(info.value?.time?.created),
            updated_at_ms: ms(info.value?.time?.updated),
          },
          permission_overrides: Array.isArray(info.value?.permission)
            ? observed("session.get.permission", info.value.permission, info.collected_at_ms!)
            : absent(
                "session.get.permission",
                "Session permission override field was not supplied",
              ),
          todo: envelope("session.todo", todo),
          diff: envelope("session.diff", diff),
          returned_result: lastFinal
            ? observed(
                "session.messages",
                {
                  message_id: lastFinal.info.id,
                  parts: lastFinal.parts,
                  finish: lastFinal.info.finish,
                },
                history.collected_at_ms!,
              )
            : absent("session.messages/task", "No completed assistant return was observed"),
        };
      }),
    );
    const currentMessages =
      sessions.find((s) => s.session_id === sessionID)?.history.value?.messages ?? [];
    let linked: any = null;
    for (const message of currentMessages)
      for (const part of message.parts ?? [])
        if (part.type === "tool" && (part.callID === callID || part.id === callID))
          linked = { message, part };
    const callIdentity = linked ? identity(linked.message) : identity(null, "unresolved");
    const activeModel = callIdentity.model;
    let catalog: ApiResult | null = null;
    if (activeModel.provider_id && activeModel.model_id) {
      catalog = await this.api("tool.list", {
        query: { provider: activeModel.provider_id, model: activeModel.model_id },
      });
      if (!catalog.error && Array.isArray(catalog.value))
        for (const entry of catalog.value)
          this.cacheDefinition(entry.id, entry, "sdk.tool.list", activeModel);
      else if (!catalog.error) catalog.error = "Expected tool definitions array";
    }
    const definitions = cloneJson([...this.definitions.values()]);
    const matching = definitions.filter(
      (d) =>
        d.tool_id === checkpoint.hookInput.tool &&
        (!d.model_filter ||
          (d.model_filter.provider_id === activeModel.provider_id &&
            d.model_filter.model_id === activeModel.model_id)),
    );
    const result =
      checkpoint.phase === "post_tool_call" ? normalizedResult(checkpoint.hookOutput) : null;
    const args =
      checkpoint.phase === "pre_tool_call"
        ? checkpoint.hookOutput?.args
        : checkpoint.hookInput.args;
    const currentCall = {
      session_id: sessionID,
      hook_call_id: callID,
      tool_call_id: str(linked?.part.callID),
      message_id: str(linked?.message.info.id),
      part_id: str(linked?.part.id),
      correlation: linked
        ? linked.part.callID === callID
          ? "part.callID"
          : "part.id"
        : "unresolved",
      tool_name: checkpoint.hookInput.tool,
      tool_origin: "unknown",
      identity: callIdentity,
      arguments: object(args) ? args : {},
      definition_ids: matching.map((d) => d.definition_id),
      definition_match: matching.length ? "registry_candidate" : "unknown",
      status:
        checkpoint.phase === "pre_tool_call"
          ? "proposed"
          : result?.format === "missing"
            ? "result_missing"
            : "returned",
      timestamps: {
        pre_observed_at_ms: checkpoint.preObservedAt,
        post_observed_at_ms: checkpoint.phase === "post_tool_call" ? checkpoint.observedAt : null,
        native_start_at_ms: ms(linked?.part.state?.time?.start),
        native_end_at_ms:
          checkpoint.phase === "post_tool_call" ? ms(linked?.part.state?.time?.end) : null,
      },
      result,
    };
    const delegations: any[] = [];
    const shared: any[] = [];
    const inFlight: any[] = [];
    for (const session of sessions)
      for (const message of session.history.value?.messages ?? [])
        for (const part of message.parts ?? []) {
          if (part.type === "tool") {
            if (
              part.state?.status === "running" &&
              !(session.session_id === sessionID && (part.id === callID || part.callID === callID))
            )
              inFlight.push({
                session_id: session.session_id,
                message_id: message.info.id,
                part: cloneJson(part),
              });
            if (part.tool === "task") {
              const isCurrent =
                session.session_id === sessionID && (part.callID === callID || part.id === callID);
              const metadata =
                isCurrent && result?.native?.metadata
                  ? result.native.metadata
                  : (part.state?.metadata ?? {});
              const inputArgs = isCurrent ? currentCall.arguments : (part.state?.input ?? {});
              const childID = str(metadata.sessionId);
              const d = {
                parent_session_id: session.session_id,
                child_session_id: childID,
                parent_message_id: str(message.info.id),
                parent_part_id: str(part.id),
                tool_call_id: str(part.callID),
                hook_call_id: isCurrent ? callID : null,
                agent_name:
                  typeof inputArgs.subagent_type === "string" ? inputArgs.subagent_type : null,
                model: modelIdentity(metadata.model),
                delegated_prompt: typeof inputArgs.prompt === "string" ? inputArgs.prompt : null,
                description:
                  typeof inputArgs.description === "string" ? inputArgs.description : null,
                delegation_depth: childID
                  ? depth(childID)
                  : session.delegation_depth === null
                    ? null
                    : session.delegation_depth + 1,
                status: isCurrent
                  ? currentCall.status === "proposed"
                    ? "proposed"
                    : "returned"
                  : ((
                      {
                        completed: "returned",
                        error: "error",
                        running: "running",
                        pending: "proposed",
                      } as AnyObject
                    )[part.state?.status] ?? "unknown"),
                tool_started_at_ms: ms(part.state?.time?.start),
                tool_ended_at_ms: isCurrent
                  ? currentCall.timestamps.native_end_at_ms
                  : ms(part.state?.time?.end),
                returned_result: isCurrent
                  ? (result?.native ?? null)
                  : (part.state?.output ?? part.state?.error ?? null),
                source: isCurrent ? "native task part + current hook" : "native task part",
              };
              delegations.push(d);
              const child = sessions.find((s) => s.session_id === childID);
              if (child && d.delegated_prompt !== null)
                child.delegated_prompt = observed("parent task input.prompt", d.delegated_prompt);
            }
            this.resourceRefs(shared, part.state?.input, {
              sessionID: session.session_id,
              messageID: message.info.id,
              partID: part.id,
              callID: part.callID,
              source: "tool.arguments",
            });
          }
          if (part.type === "file")
            this.addResource(shared, part.url, "attachment", {
              sessionID: session.session_id,
              messageID: message.info.id,
              partID: part.id,
              source: "file part",
            });
          for (const attachment of part.state?.attachments ?? [])
            this.addResource(shared, attachment.url, "attachment", {
              sessionID: session.session_id,
              messageID: message.info.id,
              partID: part.id,
              callID: part.callID,
              source: "tool attachment",
            });
        }
    this.resourceRefs(shared, currentCall.arguments, {
      sessionID,
      messageID: currentCall.message_id,
      partID: currentCall.part_id,
      callID: currentCall.tool_call_id,
      source: "current hook arguments",
    });
    if (result?.native)
      this.resourceRefs(shared, result.native, {
        sessionID,
        messageID: currentCall.message_id,
        partID: currentCall.part_id,
        callID: currentCall.tool_call_id,
        source: "current hook result",
      });
    const currentResultTruncated = result?.native?.metadata?.truncated === true;
    if (currentResultTruncated && typeof result.native.metadata.outputPath === "string")
      this.addResource(shared, result.native.metadata.outputPath, "file", {
        sessionID,
        messageID: currentCall.message_id,
        partID: currentCall.part_id,
        callID: currentCall.tool_call_id,
        source: "current hook result.metadata.outputPath (upstream truncation reference only)",
      });
    const hookSnapshots: AnyObject[] = this.hooks
      .filter((h) => h.session_id && discovered.has(h.session_id))
      .map((h) => ({
        ...cloneJson(h),
        correlation: {
          ...h.correlation,
          current_call:
            h.session_id === sessionID && h.hook_call_id === callID
              ? "direct_hook_call_id"
              : h.session_id === sessionID
                ? "same_session_only"
                : "unknown",
        },
      }));
    const eventSnapshots = this.events
      .filter((e) =>
        e.session_id
          ? discovered.has(e.session_id)
          : [
              "file.edited",
              "file.watcher.updated",
              "vcs.branch.updated",
              "mcp.tools.changed",
            ].includes(e.native.type),
      )
      .map(cloneJson);
    const approvals = this.approvals.filter((a) => discovered.has(a.session_id)).map(cloneJson);
    const selectedProvider = providers.value?.providers?.find(
      (p: any) => p.id === activeModel.provider_id,
    );
    const selected = activeModel.model_id
      ? selectedProvider?.models?.[activeModel.model_id]
      : undefined;
    const selectedModel = selected
      ? observed("config.providers selected model", safeModel(selected), providers.at)
      : absent("config.providers", "No matching model metadata was available");
    if (providers.error) Object.assign(selectedModel, failed("config.providers", providers));
    const configProjection = config.error
      ? failed("config.get", config)
      : observed("config.get allowlist", safeConfiguration(config.value), config.at);
    const servers = mcp.error
      ? failed("mcp.status", mcp)
      : observed(
          "mcp.status + config projection",
          Object.fromEntries(
            Object.entries(mcp.value ?? {}).map(([name, status]) => [
              name,
              { ...cloneJson(status as any), ...safeMcp(config.value?.mcp?.[name]) },
            ]),
          ),
          mcp.at,
        );
    const treeComplete =
      rootResolved &&
      [...infos.values()].every((x) => x.availability === "observed") &&
      [...children.values()].every((x) => x.availability === "observed") &&
      errors.length === 0;
    const context = {
      session_scope: {
        root_session_id: root,
        root_resolved: rootResolved,
        mode: "current_session_and_resolved_tree",
        requested_session_ids: [...discovered],
        discovered_session_ids: [...discovered],
        unavailable_session_ids: [...infos.entries()].filter(([, x]) => !x.value).map(([id]) => id),
        tree_complete: treeComplete,
      },
      sessions,
      delegations,
      observed_prompt_context: observed("plugin hook journal since attachment", hookSnapshots),
      tool_catalog: {
        definitions: definitions.length
          ? {
              ...observed("tool.definition + sdk.tool.list", definitions),
              availability: catalog?.error ? "partial" : "observed",
              reason: catalog?.error ?? null,
            }
          : catalog?.error
            ? failed("sdk.tool.list", catalog)
            : absent("tool.definition + sdk.tool.list", "No definition observed yet"),
      },
      skills_inventory: envelope("GET /skill", skills),
      mcp_resource_inventory: resources.error
        ? failed("GET /experimental/resource", resources)
        : observed(
            "GET /experimental/resource",
            Object.entries(resources.value).map(([key, value]) => ({
              registry_key: key,
              ...cloneJson(value as any),
            })),
            resources.at,
          ),
      runtime_configuration: {
        config_projection: configProjection,
        agents: agents.error
          ? failed("app.agents", agents)
          : observed("app.agents allowlist", agents.value.map(safeAgent), agents.at),
        selected_model: selectedModel,
        mcp_servers: servers,
      },
      workspace: {
        directory: this.options.directory,
        worktree: this.options.worktree,
        project: this.options.project
          ? observed("PluginInput.project", cloneJson(this.options.project), this.startedAt)
          : absent("PluginInput.project", "No project was supplied"),
        paths: envelope("path.get", paths),
        vcs: envelope("vcs.get", vcs),
      },
      shared_resources: {
        ...observed("native history + current arguments", shared),
        availability: "partial",
        reason: "Observed references only; not a filesystem or cross-session access audit",
      },
      journal: {
        observed_since_ms: this.startedAt,
        durable_across_restart: false,
        events: observed("public event journal since attachment", eventSnapshots),
        approval_decisions: observed("plugin + permission event journal", approvals),
        pending_permissions: permissions.error
          ? {
              ...observed(
                "permission events since attachment",
                [...this.pendingPermissions.values()].filter((e) =>
                  discovered.has(e.properties?.sessionID ?? e.data?.sessionID),
                ),
              ),
              availability: "partial",
              reason: permissions.error,
            }
          : observed(
              "GET /permission",
              permissions.value.filter((p: any) => discovered.has(p.sessionID)),
              permissions.at,
            ),
        in_flight_calls: {
          ...observed("session.messages running tool parts", inFlight),
          availability: "partial",
          reason: "Non-atomic snapshot of observed running calls only",
        },
        session_gate: checkpoint.gate,
      },
    };
    const coverage: AnyObject = {
      unavailable_fields: [],
      redactions: [],
      omissions: [],
      collection_errors: errors,
      upstream_truncation: "none_observed",
    };
    const addCoverage = (
      value: { availability: string; source: string; reason: string | null },
      path: string,
    ) => {
      if (value.availability === "collection_error" || value.availability === "not_observed")
        coverage.unavailable_fields.push({ path, reason: value.reason });
      if (value.availability === "collection_error")
        coverage.collection_errors.push({
          source: value.source,
          code: "api_collection_error",
          message: value.reason,
        });
      if (value.availability === "partial")
        coverage.omissions.push({
          path,
          reason: value.reason ?? "Partial observation",
          omitted_items: null,
          omitted_bytes: null,
        });
    };
    // Only collector-owned envelopes contribute coverage. Their values may contain
    // arbitrary native JSON, including objects that look exactly like an envelope.
    for (const [index, session] of sessions.entries())
      for (const key of [
        "delegated_prompt",
        "native_info",
        "history",
        "status",
        "permission_overrides",
        "todo",
        "diff",
        "returned_result",
      ] as const)
        addCoverage(session[key], `/context/sessions/${index}/${key}`);
    for (const [path, value] of [
      ["/context/observed_prompt_context", context.observed_prompt_context],
      ["/context/tool_catalog/definitions", context.tool_catalog.definitions],
      ["/context/skills_inventory", context.skills_inventory],
      ["/context/mcp_resource_inventory", context.mcp_resource_inventory],
      [
        "/context/runtime_configuration/config_projection",
        context.runtime_configuration.config_projection,
      ],
      ["/context/runtime_configuration/agents", context.runtime_configuration.agents],
      [
        "/context/runtime_configuration/selected_model",
        context.runtime_configuration.selected_model,
      ],
      ["/context/runtime_configuration/mcp_servers", context.runtime_configuration.mcp_servers],
      ["/context/workspace/project", context.workspace.project],
      ["/context/workspace/paths", context.workspace.paths],
      ["/context/workspace/vcs", context.workspace.vcs],
      ["/context/shared_resources", context.shared_resources],
      ["/context/journal/events", context.journal.events],
      ["/context/journal/approval_decisions", context.journal.approval_decisions],
      ["/context/journal/pending_permissions", context.journal.pending_permissions],
      ["/context/journal/in_flight_calls", context.journal.in_flight_calls],
    ] as const)
      addCoverage(value, path);
    if (!config.error)
      coverage.redactions.push({
        path: "/context/runtime_configuration/config_projection",
        reason:
          "Allowlist projection excludes credentials, provider options, environment values, command arguments and URL credentials/query",
      });
    if (!agents.error)
      coverage.redactions.push({
        path: "/context/runtime_configuration/agents",
        reason: "Agent settings projected; arbitrary options excluded",
      });
    for (let i = 0; i < hookSnapshots.length; i++)
      if (hookSnapshots[i].redaction_applied)
        coverage.redactions.push({
          path: `/context/observed_prompt_context/value/${i}`,
          reason:
            "Configuration/model/provider/header/environment settings projected; native text content retained",
        });
    for (const capture of this.captureErrors)
      if (!capture.session_id || discovered.has(capture.session_id))
        coverage.collection_errors.push({
          source: capture.source,
          code: "snapshot_error",
          message: capture.message,
        });
    if (!linked)
      coverage.unavailable_fields.push({
        path: "/current_call/part_id",
        reason: "Current hook could not be linked to a persisted native tool part",
      });
    if (currentResultTruncated) {
      coverage.upstream_truncation = "observed";
      coverage.omissions.push({
        path:
          result.format === "builtin_output"
            ? "/current_call/result/native/output"
            : "/current_call/result/native",
        reason:
          "Upstream truncation reported by current post-result metadata. The collector preserves the supplied content and metadata; any outputPath is a reference only and is not read. Completeness of other result fields is not established.",
        omitted_items: null,
        omitted_bytes: null,
      });
    }
    if (
      sessions.some((s) =>
        s.history.value?.messages.some((m: any) =>
          m.parts?.some(
            (p: any) => p.state?.metadata?.truncated === true || p.state?.time?.compacted,
          ),
        ),
      )
    )
      coverage.upstream_truncation = "observed";
    if (sessions.some((s) => s.history.availability !== "observed"))
      coverage.upstream_truncation =
        coverage.upstream_truncation === "observed" ? "observed" : "unknown";
    return {
      current_call: currentCall,
      context,
      coverage,
      collection_started_at_ms: start,
      collection_finished_at_ms: Date.now(),
    };
  }

  private resourceRefs(target: any[], args: any, info: AnyObject): void {
    if (!object(args)) return;
    for (const [key, value] of Object.entries(args)) {
      if (
        typeof value === "string" &&
        ["filePath", "file_path", "path", "directory", "url", "uri"].includes(key)
      )
        this.addResource(
          target,
          value,
          key === "url"
            ? "url"
            : key === "uri"
              ? "mcp_resource"
              : key === "directory"
                ? "directory"
                : "file",
          info,
        );
      if (Array.isArray(value)) {
        for (const nested of value) this.resourceRefs(target, nested, info);
      } else if (object(value)) this.resourceRefs(target, value, info);
    }
  }

  private addResource(target: any[], locator: any, kind: string, info: AnyObject): void {
    if (typeof locator !== "string") return;
    target.push({
      kind,
      locator,
      session_ids: [info.sessionID],
      message_id: str(info.messageID),
      part_id: str(info.partID),
      tool_call_id: str(info.callID),
      access: "reference_only",
      source: info.source,
      access_confirmed: false,
    });
  }
}
