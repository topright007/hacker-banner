import { z } from "zod";

export const Credentials = z.object({
  url: z.string().url(), run_id: z.string().min(1), run_token: z.string().min(24),
  workspace: z.string().min(1), policy_version: z.string().min(1),
});
const Decision = z.object({
  decision_id: z.string().min(1), decision: z.enum(["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/), policy_version: z.string(),
  reason_codes: z.array(z.string()), findings: z.array(z.string()), sensitive_run: z.boolean(),
  approval_id: z.string().nullable(), permit: z.string().nullable(),
}).strict();
export type Credential = z.infer<typeof Credentials>;
type Action = { tool: string; arguments: Record<string, unknown> };

export class MonitorClient {
  private broken = false;
  private pending = new Map<string, { permit: string; input: string; tool: string }>();
  private denied = new Set<string>();
  private session?: string;
  constructor(readonly credentials: Credential, private transport: typeof fetch = fetch) {
    const url = new URL(credentials.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid monitor URL");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("Remote monitor connections require HTTPS");
    }
  }
  private check(session: string) {
    if (this.broken) throw new Error("Monitor state incomplete; stop run and investigate");
    if (this.session && this.session !== session) throw new Error("Run cannot span sessions or subagents");
    this.session = session;
  }
  private async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 262144) throw new Error("Monitor event exceeds 256 KiB");
    const response = await this.transport(new URL(path, this.credentials.url), {
      method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${this.credentials.run_token}`, ...headers},
      body: encoded, signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Monitor rejected request (${response.status}); execution blocked`);
    return response.json();
  }
  async content(session: string, eventID: string, source: "user" | "repository", text: string) {
    this.check(session);
    try {
      if (text.length > 65536) throw new Error("Context exceeds monitor inspection bound");
      const response = await this.post("/v1/events", {
        run_id: this.credentials.run_id, session_id: session, event_id: eventID, source, text,
      });
      z.object({recorded: z.literal(true), findings: z.array(z.string()), sensitive_run: z.boolean()}).parse(response);
    } catch (error) { this.broken = true; throw error; }
  }
  async before(session: string, callID: string, tool: string, input: unknown) {
    this.check(session);
    this.denied.delete(callID);
    try {
    const args = z.record(z.string(), z.unknown()).parse(input);
    const action: Action = {tool, arguments: structuredClone(args)};
    const request = {schema_version: 1, run_id: this.credentials.run_id, session_id: session, call_id: callID, action};
    const response = Decision.parse(await this.post("/v1/evaluate", request));
    if (response.policy_version !== this.credentials.policy_version) throw new Error("Monitor policy changed; register a new run");
    if (response.decision !== "ALLOW") {
      this.denied.add(callID);
      throw new Error(`Monitor ${response.decision}: ${response.reason_codes.join(", ")}${response.approval_id ? `; approval ${response.approval_id}` : ""}`);
    }
    if (!response.permit) throw new Error("Missing execution permit");
    const started = await this.post("/v1/start", request, {"X-Execution-Permit": response.permit});
    z.object({started: z.literal(true)}).strict().parse(started);
    this.pending.set(callID, {permit: response.permit, input: JSON.stringify(args), tool});
    } catch (error) {
      if (!this.denied.has(callID)) this.broken = true;
      throw error;
    }
  }
  async after(session: string, callID: string, tool: string, input: unknown, status: "completed" | "error", result: unknown) {
    this.check(session);
    const pending = this.pending.get(callID);
    if (!pending) {
      if (this.denied.delete(callID)) return; // A before-hook rejection may produce an error hook.
      this.broken = true;
      throw new Error("Unobserved tool result; security state incomplete");
    }
    try {
      if (pending.tool !== tool || pending.input !== JSON.stringify(input)) throw new Error("Arguments changed after authorization");
      const response = await this.post("/v1/results", {
        run_id: this.credentials.run_id, session_id: session, call_id: callID,
        permit: pending.permit, status, result,
      });
      z.object({recorded: z.literal(true), sensitive_run: z.boolean()}).parse(response);
      this.pending.delete(callID);
    } catch (error) { this.broken = true; throw error; }
  }
}
