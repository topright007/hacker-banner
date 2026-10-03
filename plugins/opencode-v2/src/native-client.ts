import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service, type DiscoverOptions, type Endpoint } from "@opencode/client/service";

export type NativeClientOptions = {
  /** Existing OpenCode server only; the sensor never creates a listener or starts a server. */
  serverURL?: string;
  channel?: string;
  requestTimeoutMs?: number;
};

type Dependencies = {
  env: NodeJS.ProcessEnv;
  pid: number;
  home: string;
  read: (file: string) => Promise<string>;
  discover: (options: DiscoverOptions) => Promise<Endpoint | undefined>;
  make: typeof OpenCode.make;
  fetch: typeof globalThis.fetch;
};

const unavailable = () =>
  new Error(
    "OpenCode native approval connection is unavailable. Use the managed OpenCode service, or configure serverURL and OPENCODE_SENSOR_SERVER_PASSWORD for this server. No browser fallback is used.",
  );

function localURL(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw unavailable();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw unavailable();
  }
  return url.origin;
}

function serviceFile(channel: string | undefined, deps: Dependencies): string {
  // Mirrors the registration name used by the pinned 2.0.22 CLI.
  const suffix =
    channel === undefined || ["latest", "dev", "beta", "next"].includes(channel)
      ? ""
      : `-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  return join(
    deps.env.XDG_STATE_HOME ?? join(deps.home, ".local", "state"),
    "opencode",
    `service${suffix}.json`,
  );
}

/**
 * Connects only to this plugin's own OpenCode process. Discovery is lazy so a
 * service can finish publishing its registration before the first tool call.
 * Credentials remain in this transport closure, outside classifier snapshots.
 * The optional dependency argument is for isolated tests; callers omit it.
 */
export async function createNativeFormsClient(
  options: NativeClientOptions = {},
  dependencies: Partial<Dependencies> = {},
): Promise<OpenCodeClient> {
  const deps: Dependencies = {
    env: process.env,
    pid: process.pid,
    home: homedir(),
    read: (file) => readFile(file, "utf8"),
    discover: Service.discover,
    make: OpenCode.make,
    fetch: globalThis.fetch,
    ...dependencies,
  };
  const timeout = options.requestTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("Native approval request timeout must be between 1 and 120000 milliseconds.");
  }
  let endpoint: Endpoint;
  try {
    const explicit = options.serverURL ?? deps.env.OPENCODE_SENSOR_SERVER_URL;
    if (explicit !== undefined) {
      if (typeof explicit !== "string" || !explicit) throw unavailable();
      const password =
        deps.env.OPENCODE_SENSOR_SERVER_PASSWORD ??
        deps.env.OPENCODE_PASSWORD ??
        deps.env.OPENCODE_SERVER_PASSWORD;
      endpoint = {
        url: localURL(explicit),
        ...(password ? { auth: { type: "basic" as const, username: "opencode", password } } : {}),
      };
    } else {
      const file = serviceFile(options.channel, deps);
      // Check the process before any probe: a private/standalone host must not
      // accidentally post approvals to an unrelated registered service.
      const registration: unknown = JSON.parse(await deps.read(file));
      if (
        typeof registration !== "object" ||
        registration === null ||
        !("pid" in registration) ||
        registration.pid !== deps.pid ||
        !("url" in registration) ||
        typeof registration.url !== "string"
      ) {
        throw unavailable();
      }
      const expectedURL = localURL(registration.url);
      const discovered = await deps.discover({ file, version: "2.0.22" });
      if (!discovered || localURL(discovered.url) !== expectedURL) throw unavailable();
      endpoint = { ...discovered, url: expectedURL };
    }
    const timedFetch: typeof globalThis.fetch = async (input, init) => {
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const deadline = AbortSignal.timeout(timeout);
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
      try {
        return await deps.fetch(input, { ...init, signal, redirect: "error" });
      } catch {
        // Do not attach transport causes, which may contain authentication data.
        throw new Error("OpenCode native approval request failed or timed out.");
      }
    };
    const client = deps.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
      fetch: timedFetch,
    });
    const info = await client.server.info();
    if (info.pid !== deps.pid || info.version !== "2.0.22") throw unavailable();
    return client;
  } catch {
    // Neither service registration nor auth-bearing client errors enter audit.
    throw unavailable();
  }
}
