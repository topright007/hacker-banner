import test from "node:test";
import assert from "node:assert/strict";
import { MonitorClient } from "../dist/client.js";

const credentials = {url: "http://127.0.0.1:8765", run_id: "run", run_token: "test-run-token-123456789012345", workspace: "/tmp/task", policy_version: "test-policy"};
function fixture(verdict = "ALLOW", mutate = value => value) {
  const calls = [];
  const transport = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({path: url.pathname, body, headers: options.headers});
    let response;
    if (url.pathname === "/v1/evaluate") response = {decision_id: "d", decision: verdict, action_hash: "a".repeat(64), policy_version: "test-policy", reason_codes: verdict === "ALLOW" ? [] : ["P01"], findings: [], sensitive_run: false, approval_id: verdict === "REQUIRE_APPROVAL" ? "approval" : null, permit: verdict === "ALLOW" ? "permit" : null};
    else if (url.pathname === "/v1/start") response = {started: true};
    else response = {recorded: true, sensitive_run: false, ...(url.pathname === "/v1/events" ? {findings: []} : {})};
    return Response.json(mutate(response));
  };
  return {client: new MonitorClient(credentials, transport), calls};
}

test("allows only after a consumed start permit, then reports results", async () => {
  const {client, calls} = fixture();
  await client.before("session", "call", "read", {path: "x"});
  await client.after("session", "call", "read", {path: "x"}, "completed", "result");
  assert.deepEqual(calls.map(c => c.path), ["/v1/evaluate", "/v1/start", "/v1/results"]);
  assert.equal(calls[1].headers["X-Execution-Permit"], "permit");
  assert.equal(calls[2].body.permit, "permit");
});
for (const verdict of ["BLOCK", "REQUIRE_APPROVAL"]) {
  test(`${verdict} prevents fixture side effect`, async () => {
    const {client, calls} = fixture(verdict);
    let executed = false;
    await assert.rejects(async () => { await client.before("s", "c", "write", {}); executed = true; }, new RegExp(verdict));
    assert.equal(executed, false);
    assert.deepEqual(calls.map(c => c.path), ["/v1/evaluate"]);
  });
}
test("invalid response, missing permit, changed policy and failed start fail closed", async () => {
  for (const mutate of [r => ({...r, decision: "UNKNOWN"}), r => ({...r, permit: null}), r => ({...r, policy_version: "changed"})]) {
    await assert.rejects(() => fixture("ALLOW", mutate).client.before("s", "c", "read", {}));
  }
  const f = fixture("ALLOW", r => "started" in r ? {started: false} : r);
  await assert.rejects(() => f.client.before("s", "c", "read", {}));
});
test("unavailability prevents execution", async () => {
  const client = new MonitorClient(credentials, async () => {throw new Error("offline");});
  await assert.rejects(() => client.before("s", "c", "read", {}), /offline/);
});
test("a missing result report poisons further calls", async () => {
  const f = fixture();
  await f.client.before("s", "c", "read", {path: "x"});
  await assert.rejects(() => f.client.after("s", "c", "read", {path: "changed"}, "completed", "result"), /changed/);
  await assert.rejects(() => f.client.before("s", "new", "read", {}), /incomplete/);
});
test("subagent session cannot reuse credential", async () => {
  const f = fixture();
  await f.client.before("s", "c", "read", {});
  await assert.rejects(() => f.client.before("child", "new", "read", {}), /sessions/);
});
test("prompt content reaches monitor before tool authorization", async () => {
  const f = fixture();
  await f.client.content("s", "p", "user", "Review only");
  await f.client.before("s", "c", "read", {});
  assert.equal(f.calls[0].path, "/v1/events");
});
test("oversized context and HTTP credential exposure rejected", async () => {
  const f = fixture();
  await assert.rejects(() => f.client.content("s", "p", "repository", "x".repeat(65537)), /bound/);
  assert.throws(() => new MonitorClient({...credentials, url: "http://evil.local"}), /HTTPS/);
});
