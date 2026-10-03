/** A tool refusal must not persist as a session-wide lock. */
export class ActionRejectedError extends Error {
  constructor(
    message = "Sensor: пользователь отменил это действие. Не повторяйте его без нового разрешения пользователя.",
  ) {
    super(message);
    this.name = "ActionRejectedError";
  }
}
