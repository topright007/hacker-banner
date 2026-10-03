import { type ClassifierRequest, type ClassifierResponse, responseFor } from "./protocol.js";

export type Classifier = (
  request: ClassifierRequest,
  signal: AbortSignal,
) => Promise<ClassifierResponse>;

/** Local test backend. The Eliza/JEV HTTP adapter is in jev.ts. */
export const denyAllClassifier: Classifier = async (request, signal) => {
  signal.throwIfAborted();
  return responseFor(request, {
    status: "ok",
    decision: "deny",
    reason: "Тестовая заглушка отклоняет все операции; безопасность не проверялась.",
    error: null,
  });
};
