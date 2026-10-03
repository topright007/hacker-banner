import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import plugin from "../index.js";

test("V2 plugin registers blocking hooks, validates location, and disposes registrations", async () => {
  const temp = await mkdtemp(join(tmpdir(), "aidr-plugin-"));
  try {
    const workspace = join(temp, "task");
    await mkdir(workspace);
    const credentials = join(temp, "run.credentials.json");
    await writeFile(credentials, JSON.stringify({url: "http://127.0.0.1:8765", workspace, run_id: "r", run_token: "run-token-1234567890123456789", policy_version: "p"}), {mode: 0o600});
    const callbacks = new Map();
    let disposed = 0;
    const hooks = domain => async (name, fn) => {
      callbacks.set(`${domain}:${name}`, fn);
      return {dispose: async () => {disposed++;}};
    };
    const ctx = {app: {version: "2.0.22"}, options: {credentials},
      session: {get: async () => ({location: {directory: workspace}}), hook: hooks("session")},
      tool: {hook: hooks("tool")}, shell: {hook: hooks("shell")}, permission: {hook: hooks("permission")}};
    const cleanup = await plugin.setup(ctx);
    assert.equal(callbacks.size, 6);
    assert.throws(() => callbacks.get("shell:create.before")({command: "echo x"}), /P12/);
    const permission = {action: "subagent", effect: "allow"};
    callbacks.get("permission:evaluate")(permission);
    assert.equal(permission.effect, "deny");
    ctx.session.get = async () => ({location: {directory: temp}});
    await assert.rejects(() => callbacks.get("tool:execute.before")({sessionID: "s", messageID: "m", id: "c", tool: "write", input: {}}), /workspace differs/);
    await cleanup();
    assert.equal(disposed, 6);
    await assert.rejects(() => plugin.setup({...ctx, app: {version: "1.18.34"}}), /V2/);
  } finally {await rm(temp, {recursive: true, force: true});}
});
