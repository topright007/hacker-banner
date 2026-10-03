import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { Credentials, MonitorClient } from "./client.js";

export default Plugin.define({
  id: "aidr.security-monitor",
  async setup(ctx) {
    if (ctx.app.version !== "2.0.22") throw new Error("Monitor adapter requires OpenCode V2 2.0.22");
    const file = ctx.options.credentials;
    if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Set an absolute credentials path in plugin options");
    const credentials = Credentials.parse(JSON.parse(await readFile(file, "utf8")));
    const workspace = await realpath(credentials.workspace);
    const credentialPath = await realpath(file);
    const credentialRelative = relative(workspace, credentialPath);
    if (!credentialRelative.startsWith("../") && !isAbsolute(credentialRelative)) throw new Error("Credentials must be outside agent workspace");
    if ((await stat(file)).mode & 0o077) throw new Error("Run credential file must be private (0600)");
    const client = new MonitorClient(credentials);
    const toolMap = ctx.options.toolMap;
    const normalizedTool = (name: string): string => {
      if (typeof toolMap === "object" && toolMap !== null && !Array.isArray(toolMap)) {
        const mapped = (toolMap as Record<string, unknown>)[name];
        if (typeof mapped === "string") return mapped;
      }
      return name;
    };
    const registrations: {dispose(): Promise<void>}[] = [];
    const checkSession = async (sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"]) => {
      const session = await ctx.session.get({sessionID});
      if (await realpath(session.location.directory) !== workspace || session.subpath) {
        throw new Error("Session workspace differs from registered task");
      }
    };
    try {
      registrations.push(await ctx.session.hook("prompt", async event => {
        await checkSession(event.sessionID);
        if (event.prompt.files?.length) throw new Error("Prompt attachments are unsupported; read through monitored tools");
        await client.content(event.sessionID, `prompt:${event.messageID}`, "user", event.prompt.text ?? "");
      }));
      registrations.push(await ctx.session.hook("context", async event => {
        await checkSession(event.sessionID);
        await client.content(event.sessionID, `context:${randomUUID()}`, "repository", JSON.stringify({system: event.system, messages: event.messages}));
      }));
      registrations.push(await ctx.tool.hook("execute.before", async event => {
        await checkSession(event.sessionID);
        await client.before(event.sessionID, `${event.messageID}:${event.id}`, normalizedTool(event.tool), event.input);
      }));
      registrations.push(await ctx.tool.hook("execute.after", async event => {
        await client.after(event.sessionID, `${event.messageID}:${event.id}`, normalizedTool(event.tool), event.input,
          event.status, event.status === "completed" ? event.result : event.error);
      }));
      registrations.push(await ctx.shell.hook("create.before", () => {
        throw new Error("P12: Unmediated shells disabled in monitor instance");
      }));
      registrations.push(await ctx.permission.hook("evaluate", event => {
        if (["shell", "subagent", "execute", "external_directory"].includes(event.action)) {
          event.effect = "deny";
          event.message = "Disabled by security monitor prototype";
        }
      }));
    } catch (error) {
      await Promise.all(registrations.map(r => r.dispose()));
      throw error;
    }
    return async () => { await Promise.all(registrations.map(r => r.dispose())); };
  },
});
