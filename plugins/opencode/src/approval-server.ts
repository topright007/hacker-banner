import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { approvalPage } from "./approval-page.js";

type Decision = "allow" | "reject";
type Phase = "pre_tool_call" | "post_tool_call";
type Options = {
  stateDirectory: string;
  openBrowser: boolean;
  onNotice?: (message: string) => Promise<void> | void;
};
type PendingView = {
  id: string;
  request_id: string;
  phase: Phase;
  binding_digest: string;
  session_id: string;
  tool: string;
  reason: string;
  arguments: string;
  result: string | null;
  created_at_ms: number;
};
type Pending = { view: PendingView; requestJSON: string; resolve: (decision: Decision) => void };

const MAX_PENDING = 64;
const MAX_BODY_BYTES = 16_384;
const MAX_REQUESTS_PER_WINDOW = 200;
const RATE_WINDOW_MS = 10_000;

function boundedText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[Отображение сокращено; решение связано с полным исходным запросом.]`;
}

function resultPreview(snapshot: any): string {
  const result = snapshot.current_call.result;
  const native = result?.native ?? snapshot.checkpoint?.raw_output;
  if (result?.format === "missing" || native == null)
    return "Результат недоступен в этом checkpoint.";
  let preview = native;
  if (typeof native === "object" && !Array.isArray(native)) {
    if (result?.format === "mcp_call_tool_result") {
      // MCP uses protocol fields; arbitrary extensions (including numeric keys)
      // must not replace them or push them outside the bounded preview.
      // The immutable download retains every native field.
      preview = {
        content: native.content,
        structuredContent: native.structuredContent,
        isError: native.isError,
      };
    } else if (result?.format === "builtin_output") {
      // Attachments are part of the released result too, even with empty output.
      preview = {
        attachments: native.attachments,
        output: native.output,
        title: native.title,
        metadata: native.metadata,
      };
    }
  }
  return boundedText(JSON.stringify(preview, null, 2), 32_768);
}

/** Local human UI. Same-user arbitrary OS access is outside this capability boundary. */
export class ApprovalServer {
  private readonly token = randomBytes(32).toString("hex");
  private readonly instanceID = randomBytes(16).toString("hex");
  private readonly pending = new Map<string, Pending>();
  private readonly cancellationGeneration = new Map<string, number>();
  private readonly usedRequestIDs = new Set<string>();
  private readonly retiredIDs = new Set<string>();
  private readonly requestTimes: number[] = [];
  private server?: Server;
  private starting?: Promise<void>;
  private origin = "";
  private closed = false;
  private browserAttempted = false;

  constructor(private readonly options: Options) {}

  get url(): string {
    return this.origin ? `${this.origin}/#${this.token}` : "";
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Approval server is closed");
    this.starting ??= this.startServer();
    return this.starting;
  }

  async ask(request: any, response: any): Promise<Decision> {
    // Capture before the first await: callers cannot change what the human reviews.
    const requestJSON = JSON.stringify(request);
    const snapshot = JSON.parse(requestJSON);
    const sessionID = snapshot?.current_call?.session_id;
    const generation = this.cancellationGeneration.get(sessionID) ?? 0;
    await this.start();
    if (this.closed || generation !== (this.cancellationGeneration.get(sessionID) ?? 0))
      return "reject";
    const requestID = snapshot?.request_id;
    const phase = snapshot?.phase;
    const digest = snapshot?.decision_binding?.digest;
    if (
      typeof requestID !== "string" ||
      !requestID ||
      requestID.length > 1024 ||
      (phase !== "pre_tool_call" && phase !== "post_tool_call") ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      typeof sessionID !== "string" ||
      !sessionID ||
      response?.request_id !== requestID ||
      response?.phase !== phase ||
      response?.binding_digest !== digest ||
      response?.status !== "ok" ||
      response?.decision !== "deny"
    )
      throw new Error("Approval requires a matching, bound classifier deny");
    if (this.usedRequestIDs.has(requestID))
      throw new Error("Approval request was already submitted");
    if (this.pending.size >= MAX_PENDING) throw new Error("Too many pending approval requests");

    const view: PendingView = {
      id: randomBytes(16).toString("hex"),
      request_id: requestID,
      phase,
      binding_digest: digest,
      session_id: sessionID,
      tool: boundedText(snapshot.current_call.tool_name, 1024),
      reason: boundedText(response.reason, 16_384),
      arguments: boundedText(snapshot.current_call.arguments, 32_768),
      result: phase === "post_tool_call" ? resultPreview(snapshot) : null,
      created_at_ms: Date.now(),
    };
    this.usedRequestIDs.add(requestID);
    const answer = new Promise<Decision>((resolve) =>
      this.pending.set(view.id, { view, requestJSON, resolve }),
    );
    this.notice(
      `Операция ${view.tool} ожидает подтверждения. Откройте URL из ${join(this.options.stateDirectory, "control.json")}.`,
    );
    if (this.options.openBrowser && !this.browserAttempted) {
      this.browserAttempted = true;
      this.openBrowser();
    }
    return answer;
  }

  cancelSession(sessionIDs: string[]): void {
    const sessions = new Set(sessionIDs);
    for (const sessionID of sessions)
      this.cancellationGeneration.set(
        sessionID,
        (this.cancellationGeneration.get(sessionID) ?? 0) + 1,
      );
    for (const [id, item] of this.pending) {
      if (sessions.has(item.view.session_id)) this.settle(id, "reject");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.pending.keys()) this.settle(id, "reject");
    await this.starting?.catch(() => undefined);
    await this.closeListener();
    const path = join(this.options.stateDirectory, "control.json");
    try {
      const contents = JSON.parse(await readFile(path, "utf8"));
      if (contents.instance_id === this.instanceID) await unlink(path);
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        this.notice("Не удалось удалить файл управления панелью подтверждения.");
    }
  }

  private async startServer(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Approval state directory must be a real directory");
    await chmod(this.options.stateDirectory, 0o700);
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent)
          this.json(response, 500, { error: "Internal approval server error" });
        else response.destroy();
      });
    });
    this.server = server;
    server.maxConnections = 32;
    server.requestTimeout = 15_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", failed);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No approval listener address");
      this.origin = `http://127.0.0.1:${address.port}`;
      const temporary = join(this.options.stateDirectory, `.control-${this.instanceID}.tmp`);
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            instance_id: this.instanceID,
            pid: process.pid,
            url: this.url,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, join(this.options.stateDirectory, "control.json"));
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    } catch (error) {
      await this.closeListener();
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (request.headers.host !== this.origin.slice("http://".length))
      return this.json(response, 421, { error: "Invalid host" });
    if (!this.takeRequestSlot()) return this.json(response, 429, { error: "Too many requests" });
    if (request.method === "GET" && request.url === "/") {
      const nonce = randomBytes(16).toString("base64");
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(approvalPage(nonce));
      return;
    }
    if (!this.authorized(request)) return this.json(response, 401, { error: "Unauthorized" });
    if (request.method === "GET" && request.url === "/api/pending") {
      return this.json(response, 200, {
        pending: [...this.pending.values()].map((item) => item.view),
      });
    }
    const requestPath = /^\/api\/request\/([a-f0-9]{32})$/.exec(request.url ?? "");
    if (request.method === "GET" && requestPath) {
      const pending = this.pending.get(requestPath[1]!);
      if (!pending) return this.json(response, 404, { error: "Approval is no longer pending" });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="request-${pending.view.id}.json"`,
      });
      response.end(pending.requestJSON);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/decision")
      return this.json(response, 404, { error: "Not found" });
    if (request.headers.origin !== this.origin)
      return this.json(response, 403, { error: "Invalid origin" });
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
    )
      return this.json(response, 415, { error: "JSON required" });
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      response.setHeader("Connection", "close");
      return this.json(response, 413, { error: "Decision body too large" });
    }
    let body: unknown;
    try {
      body = await this.readJSON(request);
    } catch (error: any) {
      return this.json(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
        error: "Invalid decision body",
      });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return this.json(response, 400, { error: "Invalid decision" });
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(",") !== "binding_digest,decision,id,phase" ||
      typeof input.id !== "string" ||
      (input.decision !== "allow" && input.decision !== "reject")
    )
      return this.json(response, 400, { error: "Invalid decision" });
    const pending = this.pending.get(input.id);
    if (!pending)
      return this.json(response, this.retiredIDs.has(input.id) ? 409 : 404, {
        error: "Approval is no longer pending",
      });
    if (pending.view.phase !== input.phase || pending.view.binding_digest !== input.binding_digest)
      return this.json(response, 409, { error: "Approval binding mismatch" });
    this.settle(input.id, input.decision);
    this.json(response, 200, { ok: true });
  }

  private settle(id: string, decision: Decision): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.retiredIDs.add(id);
    if (this.retiredIDs.size > 4096) this.retiredIDs.delete(this.retiredIDs.values().next().value!);
    pending.resolve(decision);
  }

  private authorized(request: IncomingMessage): boolean {
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private takeRequestSlot(): boolean {
    const now = Date.now();
    while (this.requestTimes.length && this.requestTimes[0]! <= now - RATE_WINDOW_MS)
      this.requestTimes.shift();
    if (this.requestTimes.length >= MAX_REQUESTS_PER_WINDOW) return false;
    this.requestTimes.push(now);
    return true;
  }

  private async readJSON(request: IncomingMessage): Promise<unknown> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const part of request) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("Decision body too large") as Error & { code: string };
        error.code = "BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private notice(message: string): void {
    try {
      void Promise.resolve(this.options.onNotice?.(message)).catch(() => undefined);
    } catch {
      /* UI notices cannot decide a pending operation. */
    }
  }

  private openBrowser(): void {
    const command =
      process.platform === "darwin"
        ? "/usr/bin/open"
        : process.platform === "linux"
          ? "xdg-open"
          : undefined;
    if (!command) {
      this.notice(
        `Автоматическое открытие браузера недоступно. Откройте URL из ${join(this.options.stateDirectory, "control.json")}.`,
      );
      return;
    }
    try {
      const child = spawn(command, [this.url], { shell: false, detached: true, stdio: "ignore" });
      const failed = () =>
        this.notice(
          `Не удалось открыть браузер. Подтверждение всё ещё ожидается; откройте URL из ${join(this.options.stateDirectory, "control.json")}.`,
        );
      child.once("error", failed);
      child.once("exit", (code) => {
        if (code !== null && code !== 0) failed();
      });
      child.unref();
    } catch {
      this.notice(
        `Не удалось открыть браузер. Откройте URL из ${join(this.options.stateDirectory, "control.json")}.`,
      );
    }
  }

  private async closeListener(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
