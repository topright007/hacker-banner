import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { QuarantineStore } from "../src/quarantine-store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "opencode-quarantine-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "quarantine");
  return { root, directory, store: new QuarantineStore(directory) };
}

function markerPath(directory: string, sessionID: string): string {
  return join(directory, `${createHash("sha256").update(sessionID).digest("hex")}.json`);
}

test("quarantine persists across instances and contains only state metadata", async (t) => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.isQuarantined("ses_unknown"), false);
  await store.activate("ses_quarantined");
  const reopened = new QuarantineStore(directory);
  assert.equal(await reopened.isQuarantined("ses_quarantined"), true);
  assert.equal(await reopened.isQuarantined("ses_other"), false);
  const marker = JSON.parse(await readFile(markerPath(directory, "ses_quarantined"), "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), [
    "activated_at",
    "schema_version",
    "session_id",
    "status",
  ]);
  assert.equal(marker.schema_version, "1.0.0");
  assert.equal(marker.session_id, "ses_quarantined");
  assert.equal(marker.status, "quarantined");
  assert.equal(marker.activated_at, new Date(marker.activated_at).toISOString());
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(markerPath(directory, "ses_quarantined"))).mode & 0o777, 0o600);
});

test("existing instances observe another instance's activation on the next check", async (t) => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.isQuarantined("ses_shared"), false);
  await new QuarantineStore(directory).activate("ses_shared");
  assert.equal(await store.isQuarantined("ses_shared"), true);
  await rm(markerPath(directory, "ses_shared"));
  assert.equal(await store.isQuarantined("ses_shared"), true);
});

test("activation blocks locally before its persistence completes", async (t) => {
  const { store } = await fixture(t);
  const pending = store.activate("ses_concurrent");
  assert.equal(await store.isQuarantined("ses_concurrent"), true);
  await pending;
});

test("concurrent activations publish one complete marker without temporary leftovers", async (t) => {
  const { directory, store } = await fixture(t);
  const observer = new QuarantineStore(directory);
  const activations = Promise.all(
    Array.from({ length: 20 }, () => new QuarantineStore(directory).activate("ses_shared")),
  );
  // Repeated checks while writers race must never observe a partial JSON file.
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal(typeof (await observer.isQuarantined("ses_shared")), "boolean");
  }
  await activations;
  assert.equal(await store.isQuarantined("ses_shared"), true);
  assert.deepEqual(await readdir(directory), [
    markerPath(directory, "ses_shared").split("/").at(-1),
  ]);
});

test("corrupt or mismatched markers throw instead of silently releasing quarantine", async (t) => {
  const { directory, store } = await fixture(t);
  await store.activate("ses_quarantined");
  const path = markerPath(directory, "ses_quarantined");
  const valid = JSON.parse(await readFile(path, "utf8"));
  for (const contents of [
    "{",
    "null",
    "[]",
    JSON.stringify({ ...valid, session_id: "ses_other" }),
    JSON.stringify({ ...valid, schema_version: "unsupported" }),
    JSON.stringify({ ...valid, status: "allowed" }),
    JSON.stringify({ ...valid, activated_at: "invalid" }),
    " ".repeat(16 * 1024 + 1),
  ]) {
    await writeFile(path, contents);
    await assert.rejects(
      new QuarantineStore(directory).isQuarantined("ses_quarantined"),
      /Invalid quarantine marker/,
    );
    await assert.rejects(store.isQuarantined("ses_quarantined"), /Invalid quarantine marker/);
  }
});

test("read failures propagate and failed persistence retains the local quarantine", async (t) => {
  const { directory, store } = await fixture(t);
  const path = markerPath(directory, "ses_unwritable");
  await mkdir(path, { recursive: true });
  await assert.rejects(store.isQuarantined("ses_unwritable"), { code: "EISDIR" });
  await assert.rejects(store.activate("ses_unwritable"));
  assert.deepEqual(await readdir(directory), [path.split("/").at(-1)]);
  await rm(path, { recursive: true });
  assert.equal(await store.isQuarantined("ses_unwritable"), true);
});

test("session identifiers become hashes and cannot escape the state directory", async (t) => {
  const { root, directory, store } = await fixture(t);
  const sessionID = "../../outside/../quarantine-marker\n";
  await store.activate(sessionID);
  assert.equal(await new QuarantineStore(directory).isQuarantined(sessionID), true);
  assert.deepEqual(await readdir(root), ["quarantine"]);
  assert.match((await readdir(directory))[0], /^[a-f0-9]{64}\.json$/);
});

test("empty and unbounded session identifiers fail before creating state", async (t) => {
  const { root, store } = await fixture(t);
  for (const sessionID of ["", " \n\t", "a".repeat(1025), "я".repeat(513)]) {
    await assert.rejects(store.activate(sessionID), /Invalid quarantine session id/);
    await assert.rejects(store.isQuarantined(sessionID), /Invalid quarantine session id/);
  }
  assert.deepEqual(await readdir(root), []);
});
