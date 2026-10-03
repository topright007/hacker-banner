import type { Phase } from "./protocol.js";

export type QuarantineCause =
  | "user_rejected"
  | "user_quarantined"
  | "session_quarantined"
  | "quarantine_unavailable"
  | "confirmation_unavailable"
  | "snapshot_changed"
  | "cancelled"
  | "startup_failure"
  | "internal_failure"
  | "monitor_blocked"
  | "monitor_failure";

export interface QuarantineDetails {
  phase: Phase;
  tool: unknown;
  cause: QuarantineCause;
  classifierReason?: string | null;
  testClassifier?: boolean;
  outcome?: "error" | "result";
}

const reasons: Record<QuarantineCause, string> = {
  monitor_blocked:
    "Действие запрещено политикой Agent Monitor; разовое подтверждение не отменяет запрет.",
  monitor_failure: "Agent Monitor недоступен или его состояние неполно; продолжение заблокировано.",
  user_rejected: "Подтверждение не получено.",
  user_quarantined: "Пользователь выбрал режим карантина.",
  session_quarantined: "В сессии включён режим карантина.",
  quarantine_unavailable: "Не удалось проверить или сохранить режим карантина.",
  confirmation_unavailable: "Форма подтверждения OpenCode недоступна; разрешение не получено.",
  snapshot_changed: "Аргументы или результат изменились; прежнее разрешение недействительно.",
  cancelled: "Текущая проверка отменена; ожидающее разрешение недействительно.",
  startup_failure: "Сенсор не готов к проверке действия.",
  internal_failure: "Не удалось завершить сбор контекста или проверку контракта.",
};

/** Keep untrusted values single-line, valid JSON, including after truncation. */
function quotedData(value: unknown, limit: number, fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value : fallback;
  let safe = "";
  for (const character of text) {
    const encoded = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069`<>&*_\[\]]/.test(
      character,
    )
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : JSON.stringify(character).slice(1, -1);
    if (safe.length + encoded.length > limit) return `"${safe}…"`;
    safe += encoded;
  }
  return `"${safe}"`;
}

export function quarantineMessage(details: QuarantineDetails): string {
  const pre = details.phase === "pre_tool_call";
  const outcome = details.outcome === "error" ? "ошибки" : "результата";
  const quarantined = [
    "user_quarantined",
    "session_quarantined",
    "quarantine_unavailable",
  ].includes(details.cause);
  const classifierDenied =
    details.cause === "user_quarantined" || details.cause === "user_rejected";
  const reason = classifierDenied
    ? details.testClassifier
      ? "Тестовая заглушка отклоняет все операции; безопасность не проверялась."
      : details.classifierReason
    : details.cause === "monitor_blocked"
      ? details.classifierReason
      : reasons[details.cause];
  const fallback =
    classifierDenied && details.cause === "user_rejected"
      ? "Классификатор не указал причину отказа."
      : reasons[details.cause];
  const warning = pre
    ? "вызов инструмента заблокирован."
    : `инструмент выполнен; передача ${outcome} заблокирована.`;
  const state = quarantined
    ? " Режим карантина: доступен только чат; инструменты заблокированы."
    : details.cause === "monitor_failure"
      ? " Новые запросы модели и инструментов заблокированы."
      : details.cause === "monitor_blocked"
        ? " Запрет политики нельзя отменить разовым подтверждением."
        : "";
  return [
    `Предупреждение: ${warning}${state}`,
    `Инструмент: ${quotedData(details.tool, 160, "Название инструмента недоступно")}`,
    `Причина: ${quotedData(reason, 320, fallback)}`,
  ].join("\n");
}

/** Tool refusals report the checkpoint; persistent quarantine is owned by the sensor. */
export class ActionRejectedError extends Error {
  readonly quarantineCause: QuarantineCause;
  constructor(details: QuarantineDetails) {
    super(quarantineMessage(details));
    this.name = "ActionRejectedError";
    this.quarantineCause = details.cause;
  }
}
