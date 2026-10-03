/** A refusal belongs to one checkpoint, never to the lifetime of a session. */
export class ActionRejectedError extends Error {
  constructor(
    message = "Sensor: пользователь отменил это действие. Не повторяйте его без нового разрешения пользователя.",
  ) {
    super(message);
    this.name = "ActionRejectedError";
  }
}
