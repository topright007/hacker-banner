import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  cloneJson,
  object,
  pick,
  safeAgent,
  safeEndpoint,
  safeHook,
  safeModel,
  safeProvider,
  safeReference,
  serializeError,
} from "./sanitize.js";

type Native = Record<string, any>;
type Envelope = {
  availability: "observed" | "partial" | "not_observed" | "collection_error";
  source: string;
  collected_at_ms: number | null;
  reason: string | null;
  value: any;
};
export type CollectInput = {
  phase: "pre_tool_call" | "post_tool_call";
  hookInput: Native;
  hookOutput: any;
  preObservedAt: number | null;
  observedAt: number;
  gate: Native;
};
const text = (value: any): string | null => (typeof value === "string" ? value : null);
const observed = (source: string, value: any, at = Date.now()): Envelope => ({
  availability: "observed",
  source,
  collected_at_ms: at,
  reason: null,
  value,
});
const partial = (source: string, value: any, reason: string): Envelope => ({
  ...observed(source, value),
  availability: "partial",
  reason,
});
const missing = (source: string, reason: string): Envelope => ({
  availability: "not_observed",
  source,
  collected_at_ms: null,
  reason,
  value: null,
});
const hash = (value: any): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const modelOf = (value: any) => ({
  provider_id: text(value?.providerID),
  model_id: text(value?.id),
  variant: text(value?.variant),
});
const listData = (value: any): any[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : (() => {
          throw new Error("Expected a list response");
        })();

/** Public Plugin.Context only; never creates a second HTTP client or reads arbitrary files. */
export class ContextCollector {
  readonly knownParents = new Map<string, string | null>();
  private readonly startedAt = Date.now();
  private sequence = 0;
  private readonly latest = new Map<string, Native>();
  private readonly observations: Native[] = [];
  private readonly events: Native[] = [];
  private readonly approvals: Native[] = [];
  private readonly calls: Native[] = [];
  private readonly permissionEvaluations: Native[] = [];
  private readonly nativeMessages = new Map<string, Map<string, Native>>();
  private readonly semanticMessages = new Map<string, Map<string, Native>>();
  private readonly errors: Native[] = [];
  private readonly seenSessions = new Set<string>();
  constructor(private readonly options: { ctx: any; apiTimeoutMs: number }) {}

  relevantSessionIds(sessionID: string): string[] {
    let root = sessionID;
    const visited = new Set<string>();
    while (this.knownParents.get(root) && !visited.has(root)) {
      visited.add(root);
      root = this.knownParents.get(root)!;
    }
    const result = new Set([root, sessionID]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, parent] of this.knownParents)
        if (parent && result.has(parent) && !result.has(id)) {
          result.add(id);
          changed = true;
        }
    }
    return [...result];
  }
  private rememberMessages(sessionID: string, messages: any[]) {
    let stored = this.nativeMessages.get(sessionID);
    if (!stored) {
      stored = new Map();
      this.nativeMessages.set(sessionID, stored);
    }
    for (const message of messages)
      if (typeof message?.id === "string") stored.set(message.id, cloneJson(message));
  }
  private rememberSemantic(sessionID: string, messages: any[]) {
    let stored = this.semanticMessages.get(sessionID);
    if (!stored) {
      stored = new Map();
      this.semanticMessages.set(sessionID, stored);
    }
    for (const message of messages) {
      const native = cloneJson(message);
      const id = hash(native);
      if (!stored.has(id))
        stored.set(id, { content_hash: id, first_observed_at_ms: Date.now(), native });
    }
  }
  private observe(name: string, sessionID: string | null, payload: any, details: Native = {}) {
    const native = cloneJson(payload);
    const observation = {
      observation_id: randomUUID(),
      sequence: ++this.sequence,
      observed_at_ms: Date.now(),
      hook: name,
      session_id: sessionID,
      kind: details.kind ?? null,
      agent_name: text(details.agent),
      model: details.model ? modelOf(details.model) : null,
      correlation: "session_and_kind_only",
      payload: native,
    };
    const key = `${sessionID ?? "unscoped"}:${name}:${details.kind ?? ""}`;
    this.latest.set(key, observation);
    this.observations.push({
      ...pick(observation, [
        "observation_id",
        "sequence",
        "observed_at_ms",
        "hook",
        "session_id",
        "kind",
        "agent_name",
        "model",
        "correlation",
      ]),
      payload_sha256: hash(native),
    });
    if (sessionID) this.seenSessions.add(sessionID);
  }
  async observeHook(rawName: string, event: any): Promise<void> {
    const name = rawName.replace(/^session\./, "");
    const sessionID = text(event?.sessionID);
    try {
      if (name === "http.request" || name === "http.response") {
        const request = event.request as Request;
        const details = pick(event, ["sessionID", "agent", "model", "kind"]);
        const payload: Native = {
          ...details,
          request: {
            method: request.method,
            url: safeEndpoint(request.url),
            header_names: [...request.headers.keys()],
          },
        };
        if (name === "http.request" && request.body) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            payload.request.body_text = await Promise.race([
              request.clone().text(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Request body observation timeout")),
                  this.options.apiTimeoutMs,
                );
              }),
            ]);
          } catch {
            payload.request.body_unavailable =
              "Request clone could not be read within the observation deadline";
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        if (name === "http.response")
          payload.response = {
            status: event.response.status,
            status_text: event.response.statusText,
            header_names: [...event.response.headers.keys()],
            body_captured: false,
          };
        this.observe(name, sessionID, payload, details);
        return;
      }
      const snapshot = safeHook(name, event);
      if (sessionID && Array.isArray(snapshot.messages))
        this.rememberSemantic(sessionID, snapshot.messages);
      if (name === "permission.evaluate")
        this.permissionEvaluations.push({
          observed_at_ms: Date.now(),
          native: snapshot,
          session_id: sessionID,
        });
      if (name === "prompt")
        this.events.push({
          event_id: randomUUID(),
          session_id: sessionID,
          observed_at_ms: Date.now(),
          source: "prompt hook before admission",
          native: snapshot,
        });
      const kind =
        (
          {
            context: "primary",
            compaction: "compaction",
            generate: "generate",
            title: "title",
          } as Native
        )[name] ??
        snapshot.kind ??
        null;
      this.observe(name, sessionID, snapshot, { ...snapshot, kind });
      if (sessionID && ["context", "compaction", "generate", "title"].includes(name)) {
        const native = await this.api("session.context", { sessionID }, (messages) => {
          if (!Array.isArray(messages)) throw new Error("Expected active session messages");
          this.rememberMessages(sessionID, messages);
          return null;
        });
        if (native.availability === "collection_error" || native.availability === "not_observed")
          this.errors.push({
            source: `${rawName}: ctx.session.context`,
            session_id: sessionID,
            message: native.reason,
          });
      }
    } catch (error) {
      this.errors.push({
        source: rawName,
        session_id: sessionID,
        message: error instanceof Error ? error.message : "Observation failed",
      });
    }
  }
  observeEvent(event: any): void {
    try {
      const native = cloneJson(event);
      const data = native.data ?? native.properties ?? {};
      const sessionID = text(data.sessionID ?? data.request?.sessionID ?? data.form?.sessionID);
      // The stream is server-wide. Never collect credentials or unrelated global registry payloads.
      if (
        !sessionID ||
        !["session.", "permission."].some((prefix) => native.type?.startsWith(prefix))
      )
        return;
      this.seenSessions.add(sessionID);
      if (native.type === "session.created") this.knownParents.set(sessionID, text(data.parentID));
      this.events.push({
        event_id: text(native.id) ?? randomUUID(),
        session_id: sessionID,
        observed_at_ms: Date.now(),
        source: "ctx.event.subscribe",
        native,
      });
      if (object(data.message) && typeof data.message.id === "string")
        this.rememberMessages(sessionID, [data.message]);
    } catch (error) {
      this.errors.push({
        source: "event",
        session_id: null,
        message: error instanceof Error ? error.message : "Event observation failed",
      });
    }
  }
  recordApproval(item: any): void {
    this.approvals.push(
      cloneJson({
        ...item,
        decision_id: item.decision_id ?? randomUUID(),
        decided_at_ms: item.decided_at_ms ?? Date.now(),
      }),
    );
  }

  private async api(
    source: string,
    args?: any,
    project: (value: any) => any = (value) => cloneJson(value),
  ): Promise<Envelope> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const names = source.split(".");
      let receiver = this.options.ctx;
      for (const key of names.slice(0, -1)) receiver = receiver?.[key];
      const method = receiver?.[names.at(-1)!];
      if (typeof method !== "function")
        return missing(`ctx.${source}`, "This Plugin.Context method is unavailable");
      const value = await Promise.race([
        Promise.resolve().then(() => method.call(receiver, args, { signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("OpenCode API timeout"));
          }, this.options.apiTimeoutMs);
        }),
      ]);
      return observed(`ctx.${source}`, project(value));
    } catch (error) {
      return {
        availability: "collection_error",
        source: `ctx.${source}`,
        collected_at_ms: Date.now(),
        reason: error instanceof Error ? error.message : "OpenCode API failed",
        value: null,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private schemaProjection(value: any): { schema: any; status: string } {
    let schema: any = null;
    let schemaStatus = "unavailable";
    try {
      if (Schema.isSchema(value)) {
        const doc = Schema.toJsonSchemaDocument(value);
        schema = { ...doc.schema, $defs: doc.definitions };
        schemaStatus = "effect_json_schema_projection";
      } else if (
        typeof value === "boolean" ||
        (object(value) && !value["~standard"] && !value.ast)
      ) {
        schema = cloneJson(value);
        schemaStatus = "json_schema_observed";
      }
    } catch {
      schemaStatus = "conversion_failed";
    }
    return { schema, status: schemaStatus };
  }
  private definition(entry: any): Native {
    const input = this.schemaProjection(entry.input);
    const output = this.schemaProjection(entry.output);
    return {
      tool_id: entry.id ?? entry.name,
      name: entry.name,
      description: entry.description,
      input_schema: input.schema,
      schema_status: input.status,
      output_schema: output.schema,
      output_schema_status: output.status,
      options: pick(entry.options, ["namespace", "permission", "codemode", "pinned"]),
      source: "ctx.tool.list",
      scope: "plugin_location_registry",
      registry_location: cloneJson(this.options.ctx.location ?? {}),
      model_visible_exact: false,
    };
  }

  async collect(input: CollectInput): Promise<{
    current_call: Native;
    context: Native;
    coverage: Native;
    collection_started_at_ms: number;
    collection_finished_at_ms: number;
  }> {
    const started = Date.now();
    const checkpoint = cloneJson(input);
    const event = checkpoint.hookInput;
    const sessionID = event.sessionID;
    this.seenSessions.add(sessionID);
    this.calls.push({
      phase: checkpoint.phase,
      observed_at_ms: checkpoint.observedAt,
      session_id: sessionID,
      native: cloneJson(event),
    });
    const infos = new Map<string, Envelope>();
    const getInfo = async (id: string) => {
      if (infos.has(id)) return infos.get(id)!;
      const result = await this.api("session.get", { sessionID: id }, (value) => {
        if (value?.id !== id) throw new Error("Session ID mismatch");
        return cloneJson(value);
      });
      infos.set(id, result);
      if (result.value) this.knownParents.set(id, text(result.value.parentID));
      return result;
    };
    let root = sessionID;
    const ancestors = new Set<string>();
    let rootResolved = false;
    while (!ancestors.has(root)) {
      ancestors.add(root);
      const info = await getInfo(root);
      if (!info.value) break;
      const parent = text(info.value.parentID);
      if (!parent) {
        rootResolved = true;
        break;
      }
      root = parent;
    }
    const ids = this.relevantSessionIds(sessionID);
    for (const ancestor of ancestors) if (!ids.includes(ancestor)) ids.push(ancestor);
    const depth = (id: string): number | null => {
      if (!rootResolved) return null;
      const seen = new Set<string>();
      let value = 0;
      while (id !== root) {
        if (seen.has(id)) return null;
        seen.add(id);
        const parent = this.knownParents.get(id);
        if (!parent) return null;
        id = parent;
        value++;
      }
      return value;
    };
    const sessions = await Promise.all(
      ids.map(async (id) => {
        const [info, active, permissions] = await Promise.all([
          getInfo(id),
          this.api("session.context", { sessionID: id }, (value) => {
            if (!Array.isArray(value)) throw new Error("Expected active session messages");
            this.rememberMessages(id, value);
            return cloneJson(value);
          }),
          this.api("permission.list", { sessionID: id }),
        ]);
        return {
          session_id: id,
          parent_session_id: text(info.value?.parentID),
          delegation_depth: depth(id),
          native_info: info,
          active_context: active,
          observed_messages: partial(
            "ctx.session.context + public events since attachment",
            [...(this.nativeMessages.get(id)?.values() ?? [])],
            "Latest observed native version per message ID; retained across compaction. Messages never observed by this instance are unavailable.",
          ),
          pending_permissions: permissions,
        };
      }),
    );
    const current = sessions.find((s) => s.session_id === sessionID)!;
    const sessionLocation = current.native_info.value?.location;
    const location =
      typeof sessionLocation?.directory === "string"
        ? { directory: sessionLocation.directory }
        : { directory: this.options.ctx.location?.directory };
    const located = { location };
    const [
      agents,
      models,
      providers,
      mcp,
      tools,
      skills,
      references,
      commands,
      plugins,
      vcs,
      status,
      base,
      worktrees,
    ] = await Promise.all([
      this.api("agent.list", located, (value) => ({
        ...pick(value, ["location"]),
        data: listData(value).map(safeAgent),
      })),
      this.api("model.list", located, (value) => ({
        ...pick(value, ["location"]),
        data: listData(value).map(safeModel),
      })),
      this.api("provider.list", located, (value) => ({
        ...pick(value, ["location"]),
        data: listData(value).map(safeProvider),
      })),
      this.api("mcp.list", located),
      this.api("tool.list", undefined, (value) =>
        listData(value).map((entry) => this.definition(entry)),
      ),
      this.api("skill.list", located),
      this.api("reference.list", located, (value) => ({
        ...pick(value, ["location"]),
        data: listData(value).map(safeReference),
      })),
      this.api("command.list", located),
      this.api("plugin.list", located, (value) => ({
        ...pick(value, ["location"]),
        data: listData(value).map((entry) =>
          pick(entry, ["id", "name", "version", "source", "status"]),
        ),
      })),
      this.api("vcs.get", located),
      this.api("vcs.status", located),
      this.api("vcs.base", located),
      current.native_info.value?.projectID
        ? this.api("worktree.list", { projectID: current.native_info.value.projectID })
        : Promise.resolve(missing("ctx.worktree.list", "Session project ID unavailable")),
    ]);
    const scope = new Set(ids);
    const snapshots = [...this.latest.values()]
      .filter((item) => item.session_id && scope.has(item.session_id))
      .map(cloneJson);
    const modelSnapshots = snapshots.filter(
      (item) => item.session_id === sessionID && item.kind === "primary" && item.hook === "context",
    );
    const message = [...(this.nativeMessages.get(sessionID)?.values() ?? [])].find(
      (item) => item.id === event.messageID,
    );
    const model =
      message?.model ?? modelSnapshots.at(-1)?.payload.model ?? current.native_info.value?.model;
    const post = checkpoint.phase === "post_tool_call";
    const failed = post && event.status === "error";
    const result = post
      ? {
          format: failed ? "v2_tool_error" : "v2_tool_result",
          native: cloneJson(checkpoint.hookOutput),
          normalized: {
            output: failed ? null : (checkpoint.hookOutput?.output ?? null),
            content: failed ? null : (checkpoint.hookOutput?.content ?? null),
            metadata: checkpoint.hookOutput?.metadata ?? null,
            is_error: failed,
            error: failed ? checkpoint.hookOutput : null,
          },
        }
      : null;
    const currentCall = {
      session_id: sessionID,
      hook_call_id: event.id,
      tool_call_id: event.id,
      message_id: event.messageID,
      tool_name: event.tool,
      tool_origin: "unknown",
      identity: {
        agent_name: event.agent,
        model: modelOf(model),
        source: message ? "native assistant message" : "session/context observation",
        message_id: event.messageID,
      },
      arguments: event.input,
      correlation: "direct_v2_hook_ids",
      status: post ? (failed ? "error" : "returned") : "proposed",
      timestamps: {
        pre_observed_at_ms: checkpoint.preObservedAt,
        post_observed_at_ms: post ? checkpoint.observedAt : null,
      },
      result,
    };
    const context: Native = {
      session_scope: {
        root_session_id: root,
        root_resolved: rootResolved,
        mode: "current_ancestors_and_observed_descendants",
        discovered_session_ids: ids,
        tree_complete: false,
      },
      sessions,
      delegations: sessions.flatMap((session, index) =>
        session.parent_session_id
          ? [
              {
                parent_session_id: session.parent_session_id,
                child_session_id: session.session_id,
                delegation_depth: session.delegation_depth,
                relation_source: "ctx.session.get.parentID",
                evidence_paths: [`/context/sessions/${index}/native_info/value/parentID`],
                child_user_message_paths: session.observed_messages.value.flatMap(
                  (message: any, messageIndex: number) =>
                    message.type === "user"
                      ? [`/context/sessions/${index}/observed_messages/value/${messageIndex}`]
                      : [],
                ),
              },
            ]
          : [],
      ),
      model_context: {
        latest_snapshots: observed("V2 session hooks at this plugin's position", snapshots),
        snapshot_journal: partial(
          "Hook metadata since attachment",
          this.observations.filter((item) => item.session_id && scope.has(item.session_id)),
          "Only latest full snapshot for each session/hook/kind is retained. Journal stores metadata and hashes for superseded snapshots.",
        ),
        observed_semantic_messages: partial(
          "Session context/compaction/generate/title hooks",
          ids.flatMap((id) =>
            [...(this.semanticMessages.get(id)?.values() ?? [])].map((value) => ({
              session_id: id,
              ...value,
            })),
          ),
          "Distinct observed semantic message values, deduplicated by content hash. These lack guaranteed native message IDs or exact provider-request correlation.",
        ),
      },
      tool_catalog: tools,
      runtime_configuration: {
        agents,
        models,
        providers,
        mcp_servers: mcp,
        plugins,
        commands,
        skills,
        references,
      },
      workspace: {
        plugin_location: observed(
          "ctx.location",
          cloneJson(this.options.ctx.location ?? {}),
          this.startedAt,
        ),
        vcs_info: vcs,
        vcs_status: status,
        vcs_base: base,
        worktrees,
      },
      journal: {
        observed_since_ms: this.startedAt,
        durable_across_restart: false,
        events: observed(
          "ctx.event.subscribe + prompt hook since attachment",
          this.events.filter((item) => scope.has(item.session_id)).map(cloneJson),
        ),
        tool_calls: observed(
          "Tool checkpoints since attachment",
          this.calls.filter((item) => scope.has(item.session_id)).map(cloneJson),
        ),
        approval_decisions: observed(
          "Plugin decisions since attachment",
          this.approvals.filter((item) => scope.has(item.session_id)).map(cloneJson),
        ),
        permission_evaluations: partial(
          "permission.evaluate since attachment",
          this.permissionEvaluations.filter((item) => scope.has(item.session_id)).map(cloneJson),
          "Configured deny bypasses evaluate; this records the decision at this plugin's position, not later hooks or every final grant.",
        ),
        session_gate: checkpoint.gate,
      },
    };
    const shared: Native[] = [];
    const referencesFrom = (value: any, path: string, owner: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => referencesFrom(item, `${path}/${index}`, owner));
        return;
      }
      if (!object(value)) return;
      for (const [key, item] of Object.entries(value)) {
        const pointer = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (
          typeof item === "string" &&
          ["uri", "url", "path", "filePath", "file_path", "outputPath"].includes(key)
        )
          shared.push({
            locator: item,
            session_id: owner,
            source_path: pointer,
            access: "reference_only",
            access_confirmed: false,
          });
        else if (object(item) || Array.isArray(item)) referencesFrom(item, pointer, owner);
      }
    };
    sessions.forEach((session, index) =>
      referencesFrom(
        session.observed_messages.value,
        `/context/sessions/${index}/observed_messages/value`,
        session.session_id,
      ),
    );
    referencesFrom(currentCall.arguments, "/current_call/arguments", sessionID);
    if (result) referencesFrom(result.native, "/current_call/result/native", sessionID);
    context.shared_resources = partial(
      "Native message attachments and argument/result references",
      shared,
      "References are not proof of actual access or sharing; referenced files and URLs are not read.",
    );
    const coverage: Native = {
      unavailable_fields: [
        {
          path: "/context/sessions",
          reason:
            "Plugin.Context exposes active context, not complete persisted archives or a session listing API. Pre-attachment/compacted messages and unobserved descendants may be missing.",
        },
      ],
      redactions: [
        {
          path: "/context/runtime_configuration",
          reason:
            "Provider/model/agent settings are allowlisted; auth headers, API keys, arbitrary body options and environment values are excluded.",
        },
        {
          path: "/context/model_context/latest_snapshots",
          reason:
            "Transport URLs omit credentials/query; headers/env retain names only. Semantic prompt/tool content is retained.",
        },
      ],
      omissions: [],
      collection_errors: [],
      upstream_truncation: "unknown",
    };
    const add = (value: Envelope, path: string) => {
      if (value.availability === "not_observed" || value.availability === "collection_error")
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
          reason: value.reason,
          omitted_items: null,
          omitted_bytes: null,
        });
    };
    sessions.forEach((session, index) => {
      for (const key of [
        "native_info",
        "active_context",
        "observed_messages",
        "pending_permissions",
      ] as const)
        add(session[key], `/context/sessions/${index}/${key}`);
    });
    add(tools, "/context/tool_catalog");
    add(context.shared_resources, "/context/shared_resources");
    for (const group of ["model_context", "runtime_configuration", "workspace"] as const)
      for (const [name, value] of Object.entries(context[group]))
        add(value as Envelope, `/context/${group}/${name}`);
    for (const key of ["events", "tool_calls", "approval_decisions", "permission_evaluations"])
      add(context.journal[key], `/context/journal/${key}`);
    for (const error of this.errors)
      if (!error.session_id || scope.has(error.session_id))
        coverage.collection_errors.push({
          source: error.source,
          code: "observation_error",
          message: error.message,
        });
    if (result?.native?.metadata?.truncated === true) {
      coverage.upstream_truncation = "observed";
      coverage.omissions.push({
        path: "/current_call/result/native",
        reason: "Harness supplied truncated content; external output references are not read.",
        omitted_items: null,
        omitted_bytes: null,
      });
    }
    return {
      current_call: currentCall,
      context,
      coverage,
      collection_started_at_ms: started,
      collection_finished_at_ms: Date.now(),
    };
  }
}
