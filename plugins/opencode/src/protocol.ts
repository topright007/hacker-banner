import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import canonicalize from "canonicalize";
import requestSchema from "./contracts/request.schema.json";
import responseSchema from "./contracts/response.schema.json";

export type Phase = "pre_tool_call" | "post_tool_call";
// Native OpenCode objects deliberately preserve unknown fields. The wire boundary is
// checked against the versioned JSON Schemas, not the older SDK's narrower typings.
export type Native = Record<string, any>;
export type ClassifierRequest = Native & {
  request_id: string;
  phase: Phase;
  current_call: Native;
  context: Native;
  decision_binding: { format: string; digest: string };
};
export interface ClassifierResponse {
  contract: "opencode-plugin-classifier";
  contract_version: "1.1.0";
  request_id: string;
  phase: Phase;
  binding_digest: string;
  status: "ok" | "unavailable";
  decision: "allow" | "deny" | null;
  reason: string | null;
  evidence_paths: string[];
  error: { code: string; message: string; retryable: boolean } | null;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile(requestSchema);
const validateResponse = ajv.compile(responseSchema);

export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertCanonicalJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Non-finite number in classifier request");
  }
  if (typeof value === "string" && !value.isWellFormed()) {
    throw new Error("Invalid Unicode in classifier request");
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertCanonicalJson(key);
      assertCanonicalJson(child);
    }
  } else if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
    throw new Error("Non-JSON value in classifier request");
  }
}

export function digest(value: unknown): string {
  assertCanonicalJson(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("Cannot canonicalize classifier request");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

export function bindRequest(value: Native): ClassifierRequest {
  const { decision_binding: _old, ...unsigned } = value;
  const request = {
    ...unsigned,
    decision_binding: {
      format: "sha256-rfc8785-request-without-decision_binding",
      digest: digest(unsigned),
    },
  } as ClassifierRequest;
  if (!validateRequest(request)) {
    throw new Error(`Invalid classifier request: ${ajv.errorsText(validateRequest.errors)}`);
  }
  const input = request.checkpoint.raw_input;
  const call = request.current_call;
  if (
    input.sessionID !== call.session_id ||
    input.callID !== call.hook_call_id ||
    input.tool !== call.tool_name
  ) {
    throw new Error("Hook and normalized tool identity do not match");
  }
  const args = request.phase === "pre_tool_call" ? request.checkpoint.raw_output.args : input.args;
  if (digest(args) !== digest(call.arguments))
    throw new Error("Hook and normalized arguments do not match");
  if (
    request.phase === "post_tool_call" &&
    digest(request.checkpoint.raw_output) !== digest(call.result.native)
  ) {
    throw new Error("Hook and normalized result do not match");
  }
  return request;
}

export function responseFor(
  request: ClassifierRequest,
  fields: Pick<ClassifierResponse, "status" | "decision" | "reason" | "error">,
): ClassifierResponse {
  return {
    contract: "opencode-plugin-classifier",
    contract_version: "1.1.0",
    request_id: request.request_id,
    phase: request.phase,
    binding_digest: request.decision_binding.digest,
    evidence_paths: [],
    ...fields,
  };
}

export function assertResponse(
  request: ClassifierRequest,
  response: unknown,
): asserts response is ClassifierResponse {
  if (!validateResponse(response))
    throw new Error(`Invalid classifier response: ${ajv.errorsText(validateResponse.errors)}`);
  const result = response as unknown as ClassifierResponse;
  if (
    result.request_id !== request.request_id ||
    result.phase !== request.phase ||
    result.binding_digest !== request.decision_binding.digest
  ) {
    throw new Error("Classifier response belongs to a different checkpoint");
  }
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
