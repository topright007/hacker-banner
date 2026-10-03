import { type ClassifierRequest, type ClassifierResponse, responseFor } from "./protocol.js";

export type Classifier = (
  request: ClassifierRequest,
  signal: AbortSignal,
) => Promise<ClassifierResponse>;

/** Replace this adapter with an HTTP client when the real classifier is ready. */
export const denyAllClassifier: Classifier = async (request, signal) => {
  signal.throwIfAborted();
  return responseFor(request, {
    status: "ok",
    decision: "deny",
    reason:
      "Тестовая заглушка классификатора отклоняет все операции. Безопасность этого действия не проверялась. Требуется ваше разовое подтверждение.",
    error: null,
  });
};
