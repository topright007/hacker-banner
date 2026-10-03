export type JsonObject = Record<string, any>;
export const object = (value: any): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}
export function pick(value: any, keys: readonly string[]): JsonObject {
  return Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, cloneJson(value[key])]),
  );
}
export function serializeError(error: any): JsonObject {
  if (!object(error)) return { message: String(error) };
  const result = pick(
    error,
    Object.keys(error).filter((key) => key !== "cause" && key !== "error"),
  );
  Object.assign(result, pick(error, ["name", "message", "stack", "_tag", "metadata"]));
  if (!result.message) result.message = "Tool execution failed";
  for (const key of ["cause", "error"])
    if (error[key] !== undefined && error[key] !== error)
      result[key] =
        error[key] instanceof Error
          ? pick(error[key], ["name", "message", "stack"])
          : cloneJson(error[key]);
  return result;
}
export function safeEndpoint(value: any): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
const optionKeys = [
  "maxTokens",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "seed",
  "stop",
  "reasoningEffort",
  "reasoningSummary",
  "textVerbosity",
  "parallelToolCalls",
  "reasoning",
];
export function safeOptions(value: any): JsonObject {
  return Object.fromEntries(
    optionKeys
      .filter(
        (key) =>
          typeof value?.[key] === "string" ||
          typeof value?.[key] === "boolean" ||
          typeof value?.[key] === "number" ||
          (key === "stop" &&
            Array.isArray(value[key]) &&
            value[key].every((item: any) => typeof item === "string")),
      )
      .map((key) => [key, cloneJson(value[key])]),
  );
}
export function safeAgent(value: any): JsonObject {
  return {
    ...pick(value, [
      "id",
      "name",
      "model",
      "system",
      "description",
      "mode",
      "hidden",
      "color",
      "steps",
      "permissions",
    ]),
    request: { settings: safeOptions(value?.request?.settings) },
  };
}
export function safeModel(value: any): JsonObject {
  return {
    ...pick(value, [
      "id",
      "modelID",
      "providerID",
      "canonical",
      "family",
      "name",
      "compatibility",
      "package",
      "capabilities",
      "time",
      "cost",
      "status",
      "enabled",
      "limit",
    ]),
    settings: safeOptions(value?.settings),
    variants: Array.isArray(value?.variants)
      ? value.variants.map((variant: any) => ({
          ...pick(variant, ["id"]),
          settings: safeOptions(variant.settings),
        }))
      : [],
  };
}
export function safeProvider(value: any): JsonObject {
  return {
    ...pick(value, ["id", "canonical", "integrationID", "name", "activation", "package"]),
    settings: {
      ...safeOptions(value?.settings),
      ...(safeEndpoint(value?.settings?.baseURL)
        ? { baseURL: safeEndpoint(value.settings.baseURL) }
        : {}),
    },
  };
}
export function safeReference(value: any): JsonObject {
  const result = cloneJson(value);
  if (object(result?.source) && typeof result.source.repository === "string")
    result.source.repository = safeEndpoint(result.source.repository) ?? "[non-URL reference]";
  return result;
}
export function safeHook(name: string, event: any): JsonObject {
  const result = cloneJson(event);
  if (object(result.options)) result.options = safeOptions(result.options);
  if (result.headers) {
    result.header_names = Object.keys(result.headers);
    delete result.headers;
  }
  if (result.baseURL) result.baseURL = safeEndpoint(result.baseURL);
  if (result.url) result.url = safeEndpoint(result.url);
  if (result.env) {
    result.environment_names = Object.keys(result.env);
    delete result.env;
  }
  return result;
}
