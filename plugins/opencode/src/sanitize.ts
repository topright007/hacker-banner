export type JsonObject = Record<string, any>;

/** Copy JSON evidence before a hook yields; do not retain mutable harness references. */
export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

export function object(value: any): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pick(value: any, keys: readonly string[]): JsonObject {
  if (!object(value)) return {};
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, cloneJson(value[key])]),
  );
}

export function safeEndpoint(value: any): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const optionKeys = [
  "reasoningEffort",
  "reasoningSummary",
  "textVerbosity",
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "maxTokens",
  "seed",
  "parallelToolCalls",
];
export const safeOptions = (value: any): JsonObject => pick(value, optionKeys);

export function safeModel(value: any): JsonObject {
  const result = pick(value, [
    "id",
    "modelID",
    "model_id",
    "providerID",
    "provider_id",
    "name",
    "capabilities",
    "limit",
    "status",
    "cost",
    "release_date",
    "attachment",
    "reasoning",
    "tool_call",
    "temperature",
    "modalities",
    "variant",
  ]);
  if (object(value?.api))
    result.api = {
      ...pick(value.api, ["id", "npm"]),
      ...(safeEndpoint(value.api.url) ? { url: safeEndpoint(value.api.url) } : {}),
    };
  if (object(value?.options)) result.options = safeOptions(value.options);
  return result;
}

export function safeAgent(value: any): JsonObject {
  return {
    ...pick(value, [
      "name",
      "description",
      "mode",
      "native",
      "builtIn",
      "hidden",
      "topP",
      "temperature",
      "color",
      "permission",
      "model",
      "variant",
      "prompt",
      "steps",
      "maxSteps",
      "tools",
    ]),
    ...(object(value?.options) ? { options: safeOptions(value.options) } : {}),
  };
}

export function safeMcp(value: any): JsonObject {
  return {
    ...pick(value, ["type", "enabled", "timeout", "cwd"]),
    ...(safeEndpoint(value?.url) ? { url: safeEndpoint(value.url) } : {}),
  };
}

export function safeConfiguration(value: any): JsonObject {
  const result = pick(value, [
    "permission",
    "instructions",
    "model",
    "small_model",
    "default_agent",
    "subagent_depth",
    "compaction",
    "tools",
  ]);
  if (Array.isArray(result.instructions))
    result.instructions = result.instructions.map((reference: any) =>
      typeof reference === "string" && /^https?:\/\//i.test(reference)
        ? safeEndpoint(reference)
        : reference,
    );
  if (object(value?.agent))
    result.agent = Object.fromEntries(
      Object.entries(value.agent).map(([name, config]) => [name, safeAgent(config)]),
    );
  if (object(value?.mcp))
    result.mcp = Object.fromEntries(
      Object.entries(value.mcp).map(([name, config]) => [name, safeMcp(config)]),
    );
  return result;
}

export function safeHook(
  name: string,
  input: any,
  output: any,
): { input: JsonObject; output: JsonObject; redacted: boolean } {
  // Message/tool text is evidence. Only configuration surfaces are projected.
  let redacted = false;
  const before: JsonObject = { ...input };
  if (before.provider !== undefined) {
    before.provider = pick(before.provider, ["id", "name", "source"]);
    redacted = true;
  }
  if (before.model !== undefined) {
    before.model = safeModel(before.model);
    redacted = true;
  }
  let after: JsonObject = output === undefined ? {} : { ...output };
  if (name === "chat.params") {
    after = {
      ...pick(output, ["temperature", "topP", "topK", "maxOutputTokens"]),
      options: safeOptions(output?.options),
    };
    redacted = true;
  }
  if (name === "chat.headers") {
    after = { header_names: Object.keys(output?.headers ?? {}) };
    redacted = true;
  }
  if (name === "shell.env") {
    after = { environment_names: Object.keys(output?.env ?? {}) };
    redacted = true;
  }
  return { input: cloneJson(before), output: cloneJson(after), redacted };
}
