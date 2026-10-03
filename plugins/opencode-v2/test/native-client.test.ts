import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCode, OpenCodeClient } from "@opencode/client";
import { createNativeFormsClient } from "../src/native-client.js";

const secret = "native-transport-secret";
const url = "http://127.0.0.1:47123";

function fixture() {
  const calls: { read: string[]; discover: unknown[] } = { read: [], discover: [] };
  let clientOptions: Parameters<typeof OpenCode.make>[0] | undefined;
  const client = {
    server: { info: async () => ({ pid: 4242, version: "2.0.22" }) },
    session: { form: {} },
  } as unknown as OpenCodeClient;
  const dependencies = {
    env: {} as NodeJS.ProcessEnv,
    pid: 4242,
    home: "/test-home",
    read: async (file: string) => {
      calls.read.push(file);
      return JSON.stringify({ pid: 4242, url, password: secret });
    },
    discover: async (input: unknown) => {
      calls.discover.push(input);
      return { url, auth: { type: "basic" as const, username: "opencode", password: secret } };
    },
    make: ((options) => {
      clientOptions = options;
      return client;
    }) as typeof OpenCode.make,
    fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
  };
  return { client, dependencies, calls, options: () => clientOptions! };
}

test("discovers the existing matching host via official Service discovery without starting a server", async () => {
  const f = fixture();
  const result = await createNativeFormsClient({}, f.dependencies);
  assert.equal(result, f.client);
  assert.deepEqual(f.calls.discover, [
    { file: "/test-home/.local/state/opencode/service.json", version: "2.0.22" },
  ]);
  assert.equal(f.options().baseUrl, url);
  assert.equal(
    new Headers(f.options().headers).get("authorization"),
    `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`,
  );
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("refuses another registered process before probing or creating a client", async () => {
  const f = fixture();
  f.dependencies.read = async () => JSON.stringify({ pid: 4243, url, password: secret });
  await assert.rejects(createNativeFormsClient({}, f.dependencies), /connection is unavailable/);
  assert.equal(f.calls.discover.length, 0);
  assert.equal(f.options(), undefined);
});

test("uses the host channel and XDG state directory for the registration file", async () => {
  const f = fixture();
  f.dependencies.env.XDG_STATE_HOME = "/test-state";
  await createNativeFormsClient({ channel: "local" }, f.dependencies);
  assert.deepEqual(f.calls.read, ["/test-state/opencode/service-local.json"]);
});

test("supports an explicitly configured existing local host with transport-only environment credentials", async () => {
  const f = fixture();
  f.dependencies.env.OPENCODE_SENSOR_SERVER_PASSWORD = secret;
  f.dependencies.env.OPENCODE_PASSWORD = "unused-legacy-secret";
  await createNativeFormsClient({ serverURL: url }, f.dependencies);
  assert.equal(f.calls.read.length, 0);
  assert.equal(f.calls.discover.length, 0);
  assert.equal(
    new Headers(f.options().headers).get("authorization"),
    `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`,
  );
});

test("supports explicit endpoint environment configuration and the host's OPENCODE_PASSWORD", async () => {
  const f = fixture();
  f.dependencies.env.OPENCODE_SENSOR_SERVER_URL = url;
  f.dependencies.env.OPENCODE_PASSWORD = secret;
  await createNativeFormsClient({}, f.dependencies);
  assert.equal(f.options().baseUrl, url);
  assert.ok(new Headers(f.options().headers).has("authorization"));
  assert.equal(f.calls.discover.length, 0);
});

test("rejects external, credential-bearing, and ambiguous URLs without exposing secrets", async () => {
  for (const serverURL of [
    "https://example.test",
    `http://opencode:${secret}@127.0.0.1:47123`,
    `http://127.0.0.1:47123/?password=${secret}`,
    `http://127.0.0.1:47123/#${secret}`,
    "http://127.0.0.1:47123/api",
    "file:///tmp/server",
    "",
  ]) {
    const f = fixture();
    await assert.rejects(createNativeFormsClient({ serverURL }, f.dependencies), (error: Error) => {
      assert.match(error.message, /connection is unavailable/);
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.options(), undefined);
  }
});

test("rejects stale discovery or an unexpected service version even for explicit endpoints", async () => {
  for (const info of [
    { pid: 1111, version: "2.0.22" },
    { pid: 4242, version: "2.0.23" },
  ]) {
    const f = fixture();
    f.client.server.info = async () =>
      info as Awaited<ReturnType<OpenCodeClient["server"]["info"]>>;
    await assert.rejects(
      createNativeFormsClient({ serverURL: url }, f.dependencies),
      /connection is unavailable/,
    );
  }
});

test("redacts discovery failures and cannot silently connect elsewhere", async () => {
  const f = fixture();
  f.dependencies.discover = async () => {
    throw new Error(`Authorization: ${secret}`);
  };
  await assert.rejects(createNativeFormsClient({}, f.dependencies), (error: Error) => {
    assert.ok(!error.message.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.options(), undefined);
});

test("preserves caller cancellation and rejects redirects in the native transport", async () => {
  const f = fixture();
  let actualSignal: AbortSignal | undefined;
  f.dependencies.fetch = async (_input, init) => {
    assert.equal(init?.redirect, "error");
    actualSignal = init?.signal ?? undefined;
    return new Response("{}");
  };
  await createNativeFormsClient({ serverURL: url }, f.dependencies);
  const caller = new AbortController();
  await f.options().fetch!(url, { signal: caller.signal });
  assert.equal(actualSignal?.aborted, false);
  caller.abort();
  assert.equal(actualSignal?.aborted, true);
});

test("enforces a finite request timeout and removes credential-bearing transport error causes", async () => {
  const f = fixture();
  f.dependencies.fetch = async (_input, init) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.ok(init?.signal?.aborted);
    throw new Error(`Authorization: ${secret}`);
  };
  await createNativeFormsClient({ serverURL: url, requestTimeoutMs: 5 }, f.dependencies);
  await assert.rejects(f.options().fetch!(url), (error: Error) => {
    assert.match(error.message, /failed or timed out/);
    assert.ok(!error.message.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("supports the sensor's full configured timeout range and rejects invalid values", async () => {
  const f = fixture();
  await createNativeFormsClient({ serverURL: url, requestTimeoutMs: 120_000 }, f.dependencies);
  for (const requestTimeoutMs of [0, -1, 1.5, 120_001, Infinity, NaN]) {
    await assert.rejects(
      createNativeFormsClient({ serverURL: url, requestTimeoutMs }, f.dependencies),
      /between 1 and 120000/,
    );
  }
});
