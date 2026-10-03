import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export interface MonitorOptions {
  monitorCredentials?: string;
  toolMap?: Record<string, string>;
}

export interface MonitorCredentials {
  url: string;
  run_id: string;
  run_token: string;
  workspace: string;
  policy_version: string;
}

export interface MonitorDecision {
  decision_id: string;
  decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  action_hash: string;
  policy_version: string;
  reason_codes: string[];
  findings: string[];
  sensitive_run: boolean;
  approval_id: string | null;
  permit: string | null;
}

export class MonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorError";
  }
}

const MAX_REQUEST_BYTES = 262144;
const MAX_CONTENT_LENGTH = 65536;
const credentialKeys = ["url", "run_id", "run_token", "workspace", "policy_version"];
const decisionKeys = [
  "decision_id",
  "decision",
  "action_hash",
  "policy_version",
  "reason_codes",
  "findings",
  "sensitive_run",
  "approval_id",
  "permit",
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nonempty(value: unknown, max = Infinity): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCredentials(value: unknown): MonitorCredentials {
  if (
    !exactKeys(value, credentialKeys) ||
    !nonempty(value.url) ||
    !nonempty(value.run_id) ||
    !nonempty(value.run_token) ||
    value.run_token.length < 24 ||
    !nonempty(value.workspace) ||
    !isAbsolute(value.workspace) ||
    !nonempty(value.policy_version)
  ) {
    throw new MonitorError("Invalid monitor run credentials");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new MonitorError("Invalid monitor URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new MonitorError("Invalid monitor URL");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new MonitorError("Remote monitor connections require HTTPS");
  }
  return { ...value } as unknown as MonitorCredentials;
}

function parseDecision(value: unknown): MonitorDecision {
  if (
    !exactKeys(value, decisionKeys) ||
    !nonempty(value.decision_id) ||
    !["ALLOW", "BLOCK", "REQUIRE_APPROVAL"].includes(value.decision as string) ||
    typeof value.action_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.action_hash) ||
    !nonempty(value.policy_version) ||
    !stringArray(value.reason_codes) ||
    !stringArray(value.findings) ||
    typeof value.sensitive_run !== "boolean" ||
    !(value.approval_id === null || nonempty(value.approval_id)) ||
    !(value.permit === null || nonempty(value.permit))
  ) {
    throw new MonitorError("Invalid monitor decision");
  }
  if (
    (value.decision === "ALLOW" && (value.permit === null || value.approval_id !== null)) ||
    (value.decision !== "ALLOW" && value.permit !== null) ||
    (value.decision === "REQUIRE_APPROVAL" && value.approval_id === null) ||
    (value.decision === "BLOCK" && value.approval_id !== null)
  ) {
    throw new MonitorError("Invalid monitor decision authority");
  }
  return structuredClone(value) as unknown as MonitorDecision;
}

// Reject values JSON.stringify would silently drop or transform before binding the action.
function jsonArguments(value: unknown): string {
  if (!record(value)) throw new MonitorError("Monitor tool arguments must be a JSON object");
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string" && item.isWellFormed()) return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || ancestors.has(item)) {
      throw new MonitorError("Monitor tool arguments must contain valid JSON values");
    }
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new MonitorError("Monitor tool arguments must contain plain JSON objects");
    }
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (!key.isWellFormed()) throw new MonitorError("Invalid monitor argument name");
      visit(child);
    }
    // Sparse arrays are serialized as null and do not preserve the proposed values.
    if (Array.isArray(item) && Object.keys(item).length !== item.length) {
      throw new MonitorError("Monitor tool arguments must contain complete JSON arrays");
    }
    ancestors.delete(item);
  };
  visit(value);
  return JSON.stringify(value);
}

function validateToolMap(value: unknown): Record<string, string> {
  if (value === undefined) return Object.create(null);
  if (!record(value)) throw new MonitorError("Monitor toolMap must be an object");
  const result: Record<string, string> = Object.create(null);
  for (const [name, mapped] of Object.entries(value)) {
    if (!nonempty(name, 256) || !nonempty(mapped, 256)) {
      throw new MonitorError("Monitor toolMap entries must be nonempty tool names");
    }
    result[name] = mapped;
  }
  return result;
}

interface ProposedCall {
  tool: string;
  input: string;
  decision?: MonitorDecision;
}
interface PendingCall {
  tool: string;
  input: string;
  permit: string;
}

/** Service-backed execution authorization. Any incomplete observation poisons the run. */
export class MonitorBackend {
  readonly credentials: Readonly<MonitorCredentials>;
  private broken = false;
  private closed = false;
  private session?: string;
  private readonly proposed = new Map<string, ProposedCall>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly denied = new Set<string>();
  private readonly retired = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly toolMap: Record<string, string>;

  constructor(
    credentials: MonitorCredentials,
    private readonly transport: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
    toolMap?: Record<string, string>,
  ) {
    this.credentials = Object.freeze(parseCredentials(credentials));
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new MonitorError("Invalid monitor request timeout");
    }
    this.toolMap = validateToolMap(toolMap);
  }

  static async create(
    ctx: any,
    options: MonitorOptions,
    timeoutMs: number,
  ): Promise<MonitorBackend> {
    const file = options.monitorCredentials;
    if (typeof file !== "string" || !isAbsolute(file)) {
      throw new MonitorError("Set an absolute monitorCredentials path in plugin options");
    }
    try {
      const path = await realpath(file);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let credentials: MonitorCredentials;
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          (info.mode & 0o777) !== 0o600 ||
          (process.getuid && info.uid !== process.getuid())
        ) {
          throw new MonitorError(
            "Monitor run credential file must be private (0600) and owned by this user",
          );
        }
        if (info.size > MAX_CONTENT_LENGTH)
          throw new MonitorError("Invalid monitor run credentials");
        credentials = parseCredentials(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
      const workspace = await realpath(credentials.workspace);
      if (!(await stat(workspace)).isDirectory())
        throw new MonitorError("Invalid monitor workspace");
      const within = relative(workspace, path);
      if (within === "" || (!within.startsWith("../") && within !== ".." && !isAbsolute(within))) {
        throw new MonitorError("Monitor credentials must be outside the agent workspace");
      }
      if (
        typeof ctx.location?.directory !== "string" ||
        (await realpath(ctx.location.directory)) !== workspace
      ) {
        throw new MonitorError("Plugin workspace differs from registered monitor task");
      }
      return new MonitorBackend({ ...credentials, workspace }, fetch, timeoutMs, options.toolMap);
    } catch (error) {
      if (error instanceof MonitorError) throw error;
      throw new MonitorError("Unable to load monitor run credentials");
    }
  }

  get monitorRunID(): string {
    return this.credentials.run_id;
  }
  get isBroken(): boolean {
    return this.broken || this.closed;
  }
  poison(): void {
    this.broken = true;
  }

  normalizedTool(name: string): string {
    if (!nonempty(name, 256)) throw new MonitorError("Invalid monitor tool name");
    return Object.hasOwn(this.toolMap, name) ? this.toolMap[name]! : name;
  }

  private check(session: string): void {
    if (this.isBroken)
      throw new MonitorError("Monitor state incomplete; stop the run and investigate");
    if (!nonempty(session, 256) || (this.session && this.session !== session)) {
      this.poison();
      throw new MonitorError("Monitor run cannot span sessions or subagents");
    }
    this.session = session;
  }

  async checkSession(ctx: any, sessionID: string): Promise<void> {
    this.check(sessionID);
    try {
      const session = await ctx.session.get({ sessionID });
      if (
        typeof session?.location?.directory !== "string" ||
        session.subpath ||
        session.parentID ||
        (await realpath(session.location.directory)) !== this.credentials.workspace
      ) {
        throw new MonitorError("Session workspace or parent differs from registered monitor task");
      }
      this.check(sessionID);
    } catch (error) {
      this.fail(error, "Unable to verify monitor session");
    }
  }

  private fail(error: unknown, message = "Monitor request failed; execution blocked"): never {
    this.poison();
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(message);
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    permit?: string,
  ): Promise<unknown> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
      throw new MonitorError("Monitor request exceeds 256 KiB");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.controllers.add(controller);
    try {
      const requestSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      if (requestSignal.aborted || this.isBroken)
        throw new MonitorError("Monitor request cancelled; execution blocked");
      const response = await this.transport(new URL(path, this.credentials.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.run_token}`,
          ...(permit ? { "X-Execution-Permit": permit } : {}),
        },
        body: encoded,
        signal: requestSignal,
        redirect: "error",
      });
      if (!response.ok) throw new MonitorError("Monitor rejected request; execution blocked");
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_REQUEST_BYTES)
        throw new MonitorError("Monitor response exceeds 256 KiB");
      if (requestSignal.aborted || this.isBroken)
        throw new MonitorError("Monitor request cancelled; execution blocked");
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async content(
    session: string,
    eventID: string,
    source: "user" | "repository",
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.check(session);
    try {
      if (
        !nonempty(eventID, 256) ||
        !["user", "repository"].includes(source) ||
        typeof text !== "string" ||
        text.length > MAX_CONTENT_LENGTH
      ) {
        throw new MonitorError("Context exceeds monitor inspection bound or has invalid identity");
      }
      const response = await this.post(
        "/v1/events",
        {
          run_id: this.credentials.run_id,
          session_id: session,
          event_id: eventID,
          source,
          text,
        },
        signal,
      );
      if (
        !exactKeys(response, ["recorded", "findings", "sensitive_run"]) ||
        response.recorded !== true ||
        !stringArray(response.findings) ||
        typeof response.sensitive_run !== "boolean"
      ) {
        throw new MonitorError("Invalid monitor content acknowledgement");
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private action(session: string, callID: string, tool: string, input: string) {
    if (!nonempty(callID, 256) || !nonempty(tool, 256))
      throw new MonitorError("Invalid monitor call identity");
    return {
      schema_version: 1,
      run_id: this.credentials.run_id,
      session_id: session,
      call_id: callID,
      action: { tool, arguments: JSON.parse(input) as Record<string, unknown> },
    };
  }

  async evaluate(
    session: string,
    callID: string,
    tool: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<MonitorDecision> {
    this.check(session);
    try {
      if (this.pending.has(callID) || this.retired.has(callID) || this.inFlight.has(callID)) {
        throw new MonitorError("Monitor call identifier is already executing or finished");
      }
      const encoded = jsonArguments(input);
      const previous = this.proposed.get(callID);
      if (previous && (previous.tool !== tool || previous.input !== encoded)) {
        throw new MonitorError("Monitor call identifier reused with different arguments");
      }
      const request = this.action(session, callID, tool, encoded);
      this.inFlight.add(callID);
      try {
        const decision = parseDecision(await this.post("/v1/evaluate", request, signal));
        if (decision.policy_version !== this.credentials.policy_version) {
          throw new MonitorError("Monitor policy changed; register a new run");
        }
        this.proposed.set(callID, { tool, input: encoded, decision: structuredClone(decision) });
        return decision;
      } finally {
        this.inFlight.delete(callID);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async start(
    session: string,
    callID: string,
    tool: string,
    input: unknown,
    decision: MonitorDecision,
    signal?: AbortSignal,
  ): Promise<void> {
    this.check(session);
    try {
      const proposed = this.proposed.get(callID);
      const encoded = jsonArguments(input);
      const checked = parseDecision(decision);
      if (
        this.pending.has(callID) ||
        this.retired.has(callID) ||
        this.inFlight.has(callID) ||
        !proposed?.decision ||
        proposed.tool !== tool ||
        proposed.input !== encoded ||
        JSON.stringify(checked) !== JSON.stringify(proposed.decision) ||
        checked.decision !== "ALLOW" ||
        !checked.permit
      ) {
        throw new MonitorError("Monitor execution does not match the authorized call");
      }
      this.inFlight.add(callID);
      try {
        const response = await this.post(
          "/v1/start",
          this.action(session, callID, tool, encoded),
          signal,
          checked.permit,
        );
        if (!exactKeys(response, ["started"]) || response.started !== true) {
          throw new MonitorError("Invalid monitor start acknowledgement");
        }
        this.pending.set(callID, { tool, input: encoded, permit: checked.permit });
        this.proposed.delete(callID);
      } finally {
        this.inFlight.delete(callID);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  recordDenied(callID: string): void {
    if (
      !nonempty(callID, 256) ||
      this.pending.has(callID) ||
      this.inFlight.has(callID) ||
      this.retired.has(callID)
    ) {
      this.fail(new MonitorError("Invalid rejected monitor call identity"));
    }
    this.denied.add(callID);
    this.retired.add(callID);
    this.proposed.delete(callID);
  }

  async after(
    session: string,
    callID: string,
    tool: string,
    input: unknown,
    status: "completed" | "error",
    result: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    this.check(session);
    try {
      const pending = this.pending.get(callID);
      if (!pending) {
        if (status === "error" && this.denied.delete(callID)) return;
        throw new MonitorError("Unobserved tool result; monitor security state incomplete");
      }
      if (
        this.inFlight.has(callID) ||
        pending.tool !== tool ||
        pending.input !== jsonArguments(input) ||
        !["completed", "error"].includes(status)
      ) {
        throw new MonitorError("Tool outcome does not match the authorized monitor call");
      }
      this.inFlight.add(callID);
      try {
        const response = await this.post(
          "/v1/results",
          {
            run_id: this.credentials.run_id,
            session_id: session,
            call_id: callID,
            permit: pending.permit,
            status,
            result: result ?? null,
          },
          signal,
        );
        if (
          !exactKeys(response, ["recorded", "sensitive_run"]) ||
          response.recorded !== true ||
          typeof response.sensitive_run !== "boolean"
        ) {
          throw new MonitorError("Invalid monitor result acknowledgement");
        }
        this.pending.delete(callID);
        this.retired.add(callID);
      } finally {
        this.inFlight.delete(callID);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
