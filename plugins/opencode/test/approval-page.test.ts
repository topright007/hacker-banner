import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { approvalPage } from "../src/approval-page.js";

const source = approvalPage("test-nonce").match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
const capabilityKey = "opencode.sensor.approval.capability";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

async function loadPage(location: URL, sessionStorage: Storage | ReturnType<typeof storage>) {
  const status = { textContent: "", className: "" };
  const calls: { path: string; options: any }[] = [];
  const context = {
    location,
    sessionStorage,
    history: {
      replaceState(_state: unknown, _title: string, path: string) {
        location.href = new URL(path, location).href;
      },
    },
    document: {
      getElementById(id: string) {
        return id === "status" ? status : {};
      },
    },
    async fetch(path: string, options: any) {
      calls.push({ path, options });
      return {
        ok: true,
        async json() {
          return { pending: [] };
        },
      };
    },
    setInterval() {},
  };
  // Other persistent credential channels are forbidden; fail if production JS accesses them.
  Object.defineProperty(context, "localStorage", {
    get() {
      throw new Error("localStorage is forbidden");
    },
  });
  Object.defineProperty(context.document, "cookie", {
    get() {
      throw new Error("cookies are forbidden");
    },
    set() {
      throw new Error("cookies are forbidden");
    },
  });
  runInNewContext(source, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { calls, status: status.textContent };
}

test("actual page JS restores bearer after reload using this tab's sessionStorage", async () => {
  const tab = storage();
  const location = new URL("http://127.0.0.1:12345/#first-capability");
  const first = await loadPage(location, tab);
  assert.equal(first.calls[0]?.options.headers.Authorization, "Bearer first-capability");
  assert.equal(location.hash, "");
  assert.equal(tab.getItem(capabilityKey), "first-capability");
  const reloaded = await loadPage(location, tab);
  assert.equal(reloaded.calls[0]?.options.headers.Authorization, "Bearer first-capability");
  assert.equal(reloaded.calls[0]?.options.credentials, "omit");
  assert.ok(!reloaded.status.includes("first-capability"));
  const separateTab = await loadPage(new URL(location), storage());
  assert.equal(separateTab.calls.length, 0);
});

test("new fragment replaces a stale capability and is used after the next reload", async () => {
  const tab = storage();
  tab.setItem(capabilityKey, "stale-capability");
  const location = new URL("http://127.0.0.1:12345/#new-capability");
  const loaded = await loadPage(location, tab);
  assert.equal(loaded.calls[0]?.options.headers.Authorization, "Bearer new-capability");
  assert.equal(tab.getItem(capabilityKey), "new-capability");
  assert.equal(location.hash, "");
  const reloaded = await loadPage(location, tab);
  assert.equal(reloaded.calls[0]?.options.headers.Authorization, "Bearer new-capability");
});

test("failed storage writes preserve the fragment and do not fall back to a stale token", async () => {
  const disabled = {
    getItem() {
      return "stale-capability";
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  const location = new URL("http://127.0.0.1:12345/#recoverable-capability");
  const first = await loadPage(location, disabled);
  assert.equal(first.calls[0]?.options.headers.Authorization, "Bearer recoverable-capability");
  assert.equal(location.hash, "#recoverable-capability");
  const reloaded = await loadPage(location, disabled);
  assert.equal(reloaded.calls[0]?.options.headers.Authorization, "Bearer recoverable-capability");
  assert.ok(!reloaded.status.includes("recoverable-capability"));
});

test("failed storage reads preserve a new fragment and an empty URL asks for recovery", async () => {
  const disabled = {
    getItem(): string | null {
      throw new Error("SecurityError");
    },
    setItem() {},
  };
  const location = new URL("http://127.0.0.1:12345/#recoverable-capability");
  const first = await loadPage(location, disabled);
  assert.equal(first.calls[0]?.options.headers.Authorization, "Bearer recoverable-capability");
  assert.equal(location.hash, "#recoverable-capability");
  const empty = await loadPage(new URL("http://127.0.0.1:12345/"), disabled);
  assert.equal(empty.calls.length, 0);
  assert.match(empty.status, /control\.json/);
});

test("silent storage write failure does not remove the only usable capability", async () => {
  const unavailable = {
    getItem() {
      return null;
    },
    setItem() {},
  };
  const location = new URL("http://127.0.0.1:12345/#recoverable-capability");
  const first = await loadPage(location, unavailable);
  assert.equal(first.calls[0]?.options.headers.Authorization, "Bearer recoverable-capability");
  assert.equal(location.hash, "#recoverable-capability");
});
