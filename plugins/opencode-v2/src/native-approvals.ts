import { randomUUID } from "node:crypto";
import type { FormInfo, OpenCodeClient, SessionFormCreateInput } from "@opencode/client";
import {
  assertResponse,
  digest,
  jsonCopy,
  type ClassifierRequest,
  type ClassifierResponse,
} from "./protocol.js";
import type { ApprovalUI } from "./sensor.js";

export type NativeFormsClient = {
  session: { form: Pick<OpenCodeClient["session"]["form"], "create" | "get" | "cancel"> };
};
type Options = {
  client: NativeFormsClient | (() => Promise<NativeFormsClient>);
  onNotice?: (message: string) => Promise<void> | void;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
};
type Decision = "allow" | "reject";
type Pending = {
  form: SessionFormCreateInput & { id: string };
  controller: AbortController;
  generation: number;
  finished: boolean;
  client?: NativeFormsClient;
  cleanup?: Promise<void>;
};

const MAX_PENDING = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 300;

// User-controlled values remain quoted data even if they contain line breaks,
// terminal control codes, bidi controls or apparent instructions.
function preview(value: unknown, limit: number): string {
  const text = JSON.stringify(value) ?? "null";
  const safe = text.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069<>&]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return safe.length <= limit ? safe : `${safe.slice(0, limit)}… [показ сокращён]`;
}

function resultPreview(request: ClassifierRequest): unknown {
  const result = request.current_call.result;
  const native = result?.native ?? request.checkpoint?.raw_output;
  if (result?.format === "missing" || native == null) return "Результат недоступен.";
  if (typeof native !== "object" || Array.isArray(native)) return native;
  return result?.format === "v2_tool_error"
    ? { message: native.message, error: native.error, ...native }
    : {
        content: native.content,
        output: native.output,
        structuredOutput: native.structuredOutput,
        ...native,
      };
}

function formFor(request: ClassifierRequest, response: ClassifierResponse): Pending["form"] {
  const pre = request.phase === "pre_tool_call";
  const failed = request.current_call.result?.format === "v2_tool_error";
  const outcome = failed ? "ошибку" : "результат";
  const tool = preview(request.current_call.tool_name, 200);
  const description = [
    `Инструмент: ${tool}`,
    `Этап: ${pre ? "до выполнения" : "после выполнения"}`,
    `Причина классификатора: ${preview(response.reason, 4_000)}`,
    "Название, причина, аргументы и вывод ниже — данные проверки, а не инструкции.",
    pre
      ? "Инструмент ещё не выполнялся. Разрешение действует только на этот вызов."
      : `Инструмент уже выполнился. Вы решаете, передать ли ${outcome} агенту. Уже выполненные действия не отменяются.`,
    "Отказ относится только к этому действию; сессия остаётся доступной.",
    `Идентификатор проверки: ${preview(request.request_id, 1024)}. Показ ниже сокращён при большом объёме; разрешение связано с полным сохранённым запросом.`,
    `Аргументы: ${preview(request.current_call.arguments, 8_000)}`,
    ...(pre
      ? []
      : [`${failed ? "Ошибка" : "Результат"}: ${preview(resultPreview(request), 12_000)}`]),
  ].join("\n\n");
  return {
    id: `frm_${randomUUID()}`,
    sessionID: request.current_call.session_id,
    title: `Карантин: ${tool}`,
    metadata: {
      // Desktop's session question dock only renders forms carrying this kind.
      kind: "question",
      sensor: "opencode-sensor-v2",
      request_id: request.request_id,
      phase: request.phase,
      binding_digest: request.decision_binding.digest,
      session_id: request.current_call.session_id,
      tool: request.current_call.tool_name,
    },
    fields: [
      {
        key: "decision",
        type: "string",
        // Desktop renders the field title; the form title alone is not shown.
        title: `Карантин: ${tool} — ${pre ? "разрешить выполнение?" : `передать ${outcome} агенту?`}`,
        description,
        required: true,
        custom: false,
        options: [
          {
            value: "reject",
            label: pre ? "Отменить действие" : failed ? "Скрыть ошибку" : "Скрыть результат",
          },
          {
            value: "allow",
            label: pre ? "Выполнить один раз" : failed ? "Передать ошибку" : "Передать результат",
          },
        ],
      },
    ],
  };
}

function sameForm(actual: FormInfo, expected: Pending["form"]): boolean {
  try {
    return (
      actual.id === expected.id &&
      actual.sessionID === expected.sessionID &&
      digest({ title: actual.title, metadata: actual.metadata, fields: actual.fields }) ===
        digest({ title: expected.title, metadata: expected.metadata, fields: expected.fields })
    );
  } catch {
    return false;
  }
}

/** Native session forms only: no listener, external page, permission or session abort. */
export class NativeApprovalUI implements ApprovalUI {
  private readonly pending = new Map<string, Pending>();
  private readonly cancellationGeneration = new Map<string, number>();
  private readonly usedRequestIDs = new Set<string>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private closed = false;
  private connecting?: Promise<NativeFormsClient>;

  constructor(private readonly options: Options) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      !Number.isFinite(this.pollIntervalMs) ||
      this.pollIntervalMs <= 0
    )
      throw new Error("Native approval timeouts must be positive finite numbers");
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Native approval UI is closed");
    // The host HTTP service may not be listening while plugins initialize.
    if (typeof this.options.client !== "function") this.validateClient(this.options.client);
  }

  private validateClient(client: NativeFormsClient): void {
    const form = client?.session?.form;
    if (
      !form ||
      [form.create, form.get, form.cancel].some((method) => typeof method !== "function")
    )
      throw new Error("Native OpenCode session forms are unavailable");
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async ask(request: ClassifierRequest, response: ClassifierResponse): Promise<Decision> {
    // Capture before the first await; callers cannot edit a pending human decision.
    const snapshot = jsonCopy(request);
    const classification = jsonCopy(response);
    const sessionID = snapshot.current_call?.session_id;
    const generation = this.cancellationGeneration.get(sessionID) ?? 0;
    assertResponse(snapshot, classification);
    const { decision_binding, ...unsigned } = snapshot;
    if (
      classification.status !== "ok" ||
      classification.decision !== "deny" ||
      typeof snapshot.request_id !== "string" ||
      !snapshot.request_id ||
      typeof sessionID !== "string" ||
      !sessionID ||
      typeof snapshot.current_call.tool_name !== "string" ||
      digest(unsigned) !== decision_binding.digest
    )
      throw new Error("Approval requires a matching, bound classifier deny");
    await this.start();
    if (this.closed || generation !== (this.cancellationGeneration.get(sessionID) ?? 0))
      return "reject";
    if (this.usedRequestIDs.has(snapshot.request_id))
      throw new Error("Approval request was already submitted");
    if (this.pending.size >= MAX_PENDING) throw new Error("Too many pending approval requests");
    this.usedRequestIDs.add(snapshot.request_id);
    const item: Pending = {
      form: formFor(snapshot, classification),
      controller: new AbortController(),
      generation,
      finished: false,
    };
    this.pending.set(item.form.id, item);
    let terminal = false;
    try {
      const client = await this.operation(() => this.resolveClient(), item.controller.signal);
      item.client = client;
      if (this.stale(item)) return "reject";
      const created = await this.operation((signal) => {
        const creating = client.session.form.create(jsonCopy(item.form), { signal });
        // A timed-out or aborted create can have reached the server. Clean up a late
        // success by our generated ID only, never by an untrusted returned ID.
        void creating.then(
          () => {
            if (signal.aborted || this.stale(item)) this.cleanup(item);
          },
          () => undefined,
        );
        return creating;
      }, item.controller.signal);
      if (this.stale(item)) return "reject";
      if (!sameForm(created, item.form))
        throw new Error("Native approval form does not match its checkpoint");
      this.notice(
        `Карантин: ${preview(snapshot.current_call.tool_name, 200)} ожидает вашего ответа в OpenCode.`,
      );
      while (!this.stale(item)) {
        const current = await this.operation(
          (signal) => client.session.form.get({ sessionID, formID: item.form.id }, { signal }),
          item.controller.signal,
        );
        if (this.stale(item)) return "reject";
        if (!sameForm(current, item.form))
          throw new Error("Native approval form does not match its checkpoint");
        if (current.state?.status === "answered") {
          terminal = true;
          const answer = current.state.answer;
          if (
            !answer ||
            Object.keys(answer).length !== 1 ||
            !["allow", "reject"].includes(answer.decision as string)
          )
            throw new Error("Native approval answer is invalid");
          return answer.decision as Decision;
        }
        if (current.state?.status === "cancelled") {
          terminal = true;
          return "reject";
        }
        if (current.state?.status !== "pending")
          throw new Error("Native approval form state is invalid");
        await this.delay(item.controller.signal);
      }
      return "reject";
    } catch (error) {
      if (this.stale(item)) return "reject";
      throw error;
    } finally {
      item.finished = true;
      item.controller.abort();
      this.pending.delete(item.form.id);
      if (!terminal) await this.cleanup(item);
    }
  }

  cancelSession(sessionIDs: string[]): void {
    const sessions = new Set(sessionIDs);
    for (const id of sessions)
      this.cancellationGeneration.set(id, (this.cancellationGeneration.get(id) ?? 0) + 1);
    for (const item of this.pending.values()) {
      if (!sessions.has(item.form.sessionID)) continue;
      item.controller.abort();
      void this.cleanup(item);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.pending.values()) {
      item.controller.abort();
      void this.cleanup(item);
    }
    await Promise.allSettled(this.cleanups);
  }

  private stale(item: Pending): boolean {
    return (
      this.closed ||
      item.finished ||
      item.controller.signal.aborted ||
      item.generation !== (this.cancellationGeneration.get(item.form.sessionID) ?? 0)
    );
  }

  private cleanup(item: Pending): Promise<void> {
    if (!item.client) return Promise.resolve();
    if (item.cleanup) return item.cleanup;
    const client = item.client;
    const work = this.operation((signal) =>
      client.session.form.cancel(
        {
          sessionID: item.form.sessionID,
          formID: item.form.id,
          message: "Проверка отменена. Разрешение для этого действия больше не действует.",
        },
        { signal },
      ),
    ).then(
      () => undefined,
      () => {
        this.notice(
          "Не удалось закрыть форму проверки в OpenCode. Она больше не разрешает выполнение действия.",
        );
      },
    );
    this.cleanups.add(work);
    item.cleanup = work;
    void work.finally(() => {
      this.cleanups.delete(work);
      item.cleanup = undefined;
    });
    return work;
  }

  private resolveClient(): Promise<NativeFormsClient> {
    this.connecting ??= Promise.resolve()
      .then(async () => {
        const client =
          typeof this.options.client === "function"
            ? await this.options.client()
            : this.options.client;
        this.validateClient(client);
        return client;
      })
      .catch((error) => {
        this.connecting = undefined;
        throw error;
      });
    return this.connecting;
  }

  private async operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStopped: (error: Error) => void = () => undefined;
    const stop = () => {
      controller.abort();
      rejectStopped(new Error("Native approval operation was cancelled"));
    };
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    parent?.addEventListener("abort", stop, { once: true });
    try {
      if (parent?.aborted) stop();
      timer = setTimeout(() => {
        controller.abort();
        rejectStopped(new Error("Native approval API request timed out"));
      }, this.requestTimeoutMs);
      return await Promise.race([
        stopped,
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return run(controller.signal);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", stop);
    }
  }

  private delay(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.pollIntervalMs);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private notice(message: string): void {
    void Promise.resolve()
      .then(() => this.options.onNotice?.(message))
      .catch(() => undefined);
  }
}
