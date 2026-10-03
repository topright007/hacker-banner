import assert from "node:assert/strict";
import test from "node:test";
import type { FormDetail, FormInfo, SessionFormCreateInput } from "@opencode/client";
import { NativeApprovalUI, type NativeFormsClient } from "../src/native-approvals.js";
import {
  digest,
  jsonCopy,
  responseFor,
  type ClassifierRequest,
  type Phase,
} from "../src/protocol.js";

function checkpoint(
  id: string,
  sessionID = "ses_a",
  phase: Phase = "pre_tool_call",
  failed = false,
) {
  const unsigned = {
    contract_version: "2.1.0" as const,
    request_id: id,
    phase,
    current_call: {
      session_id: sessionID,
      tool_name: "shell",
      arguments: { command: "echo test" },
      ...(phase === "post_tool_call"
        ? {
            result: {
              format: failed ? "v2_tool_error" : "v2_tool_result",
              native: failed
                ? { message: "Секретная ошибка инструмента", _tag: "ToolError" }
                : { content: "Вывод инструмента", output: { example: 1 } },
            },
          }
        : {}),
    },
    context: {
      private_session_history: "Do not publish the full classifier context in form metadata",
    },
  };
  const request = {
    ...unsigned,
    decision_binding: {
      format: "sha256-rfc8785-request-without-decision_binding",
      digest: digest(unsigned),
    },
  } as ClassifierRequest;
  return {
    request,
    response: responseFor(request, {
      status: "ok",
      decision: "deny",
      reason: "Подозрительное действие",
      error: null,
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for native approval test state");
}

function fixture(t: any, options: { requestTimeoutMs?: number } = {}) {
  const forms = new Map<string, FormDetail>();
  const created: SessionFormCreateInput[] = [];
  const cancelled: string[] = [];
  const notices: string[] = [];
  const client: NativeFormsClient = {
    session: {
      form: {
        async create(input) {
          created.push(jsonCopy(input));
          const info = jsonCopy(input) as FormInfo;
          forms.set(info.id, { ...info, state: { status: "pending" } });
          return info;
        },
        async get(input) {
          const form = forms.get(input.formID);
          if (!form) throw new Error("Form not found");
          return jsonCopy(form);
        },
        async cancel(input) {
          cancelled.push(input.formID);
          const form = forms.get(input.formID);
          if (form) form.state = { status: "cancelled" };
        },
      },
    },
  };
  const ui = new NativeApprovalUI({
    client,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    pollIntervalMs: 2,
    onNotice(message) {
      notices.push(message);
    },
  });
  t.after(() => ui.close());
  return {
    ui,
    client,
    forms,
    created,
    cancelled,
    notices,
    async pending(count = 1) {
      await until(() => created.length === count);
      return forms.get(created[count - 1].id!)!;
    },
    answer(form: FormDetail, decision: string) {
      form.state = { status: "answered", answer: { decision } };
    },
  };
}

test("native create is one explicit deny-first choice bound to immutable checkpoint", async (t) => {
  const f = fixture(t);
  const item = checkpoint("req_shape");
  const answer = f.ui.ask(item.request, item.response);
  item.request.current_call.arguments.command = "mutated after ask";
  item.response.reason = "mutated reason";
  const form = await f.pending();
  assert.match(form.id, /^frm_/);
  assert.equal(form.sessionID, "ses_a");
  assert.equal(form.title, 'Карантин: "shell"');
  assert.deepEqual(form.metadata, {
    kind: "question",
    sensor: "opencode-sensor-v2",
    request_id: "req_shape",
    phase: "pre_tool_call",
    binding_digest: item.request.decision_binding.digest,
    session_id: "ses_a",
    tool: "shell",
  });
  const field = form.fields[0];
  assert.equal(field.type, "string");
  assert.equal(field.key, "decision");
  assert.equal(field.required, true);
  assert.equal("default" in field, false);
  assert.equal("url" in field, false);
  assert.equal(field.type === "string" && field.custom, false);
  assert.deepEqual(field.type === "string" && field.options?.map((option) => option.value), [
    "reject",
    "allow",
  ]);
  assert.match(field.description!, /echo test/);
  assert.match(field.description!, /Подозрительное действие/);
  assert.doesNotMatch(JSON.stringify(form), /mutated|private_session_history/);
  f.answer(form, "allow");
  assert.equal(await answer, "allow");
  assert.equal(f.ui.pendingCount, 0);
  assert.equal(f.cancelled.length, 0);
});

test("Desktop question dock can select and identify every checkpoint phase", async (t) => {
  const f = fixture(t);
  const scenarios = [
    {
      phase: "pre_tool_call" as const,
      failed: false,
      title: 'Карантин: "shell" — разрешить выполнение?',
    },
    {
      phase: "post_tool_call" as const,
      failed: false,
      title: 'Карантин: "shell" — передать результат агенту?',
    },
    {
      phase: "post_tool_call" as const,
      failed: true,
      title: 'Карантин: "shell" — передать ошибку агенту?',
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const item = checkpoint(`req_desktop_${index}`, "ses_a", scenario.phase, scenario.failed);
    const answer = f.ui.ask(item.request, item.response);
    const form = await f.pending(index + 1);
    // Desktop selects question-kind forms and renders string/multiselect fields.
    assert.equal(form.metadata?.kind, "question");
    assert.equal(form.fields[0].type, "string");
    assert.equal(form.fields[0].title, scenario.title);
    f.answer(form, "reject");
    assert.equal(await answer, "reject");
  }
});

test("reject cancels only one checkpoint; next same-session approval works", async (t) => {
  const f = fixture(t);
  const first = checkpoint("req_reject");
  const answer = f.ui.ask(first.request, first.response);
  f.answer(await f.pending(), "reject");
  assert.equal(await answer, "reject");
  const next = checkpoint("req_next");
  const nextAnswer = f.ui.ask(next.request, next.response);
  f.answer(await f.pending(2), "allow");
  assert.equal(await nextAnswer, "allow");
});

test("post-error form describes error release and cannot promise rollback", async (t) => {
  const f = fixture(t);
  const item = checkpoint("req_error", "ses_error", "post_tool_call", true);
  const answer = f.ui.ask(item.request, item.response);
  const form = await f.pending();
  const field = form.fields[0];
  assert.match(field.description!, /уже выполнился/);
  assert.match(field.description!, /не отменяются/);
  assert.match(field.description!, /Секретная ошибка инструмента/);
  assert.deepEqual(field.type === "string" && field.options?.map((option) => option.label), [
    "Скрыть ошибку",
    "Передать ошибку",
  ]);
  f.answer(form, "reject");
  assert.equal(await answer, "reject");
});

test("post form previews native structured output and extensions with explicit truncation", async (t) => {
  const f = fixture(t);
  const item = checkpoint("req_full_result", "ses_a", "post_tool_call");
  item.request.current_call.result.native = {
    extension: "x".repeat(20_000),
    content: "Important native content",
    structuredOutput: { security: "structured value" },
    output: { id: 123 },
  };
  const { decision_binding: _, ...unsigned } = item.request;
  item.request.decision_binding.digest = digest(unsigned);
  item.response.binding_digest = item.request.decision_binding.digest;
  const answer = f.ui.ask(item.request, item.response);
  const form = await f.pending();
  assert.match(form.fields[0].description!, /Important native content/);
  assert.match(form.fields[0].description!, /structured value/);
  assert.match(form.fields[0].description!, /extension/);
  assert.match(form.fields[0].description!, /показ сокращён/);
  assert.ok(form.fields[0].description!.length < 26_000);
  f.answer(form, "reject");
  assert.equal(await answer, "reject");
});

test("missing, wrong-type and extra answers never authorize", async (t) => {
  const f = fixture(t);
  const badAnswers = [
    {},
    { decision: true },
    { decision: "ALLOW" },
    { decision: "allow", extra: "allow" },
    { wrong: "allow" },
  ];
  for (const [i, invalid] of badAnswers.entries()) {
    const item = checkpoint(`req_bad_answer_${i}`);
    const answer = f.ui.ask(item.request, item.response);
    const form = await f.pending(i + 1);
    form.state = { status: "answered", answer: invalid } as FormDetail["state"];
    await assert.rejects(answer, /answer is invalid/);
  }
});

test("changed form identity, metadata or displayed content cannot authorize", async (t) => {
  const f = fixture(t);
  const mutate = [
    (form: FormDetail) => {
      form.id = "frm_foreign";
    },
    (form: FormDetail) => {
      form.sessionID = "ses_foreign";
    },
    (form: FormDetail) => {
      form.metadata!.binding_digest = "b".repeat(64);
    },
    (form: FormDetail) => {
      form.title = "Benign command";
    },
    (form: FormDetail) => {
      form.fields[0].description = "Changed explanation";
    },
  ];
  for (const [i, change] of mutate.entries()) {
    const item = checkpoint(`req_altered_${i}`);
    const answer = f.ui.ask(item.request, item.response);
    const form = await f.pending(i + 1);
    change(form);
    f.answer(form, "allow");
    await assert.rejects(answer, /does not match its checkpoint/);
  }
  assert.equal(f.cancelled.includes("frm_foreign"), false);
});

test("a mismatched create response is denied without trusting its foreign ID", async (t) => {
  const f = fixture(t);
  const create = f.client.session.form.create;
  f.client.session.form.create = async (input, options) => ({
    ...(await create(input, options)),
    id: "frm_other",
  });
  const item = checkpoint("req_bad_create");
  await assert.rejects(f.ui.ask(item.request, item.response), /does not match its checkpoint/);
  assert.deepEqual(f.cancelled, [f.created[0].id]);
});

test("native cancellation and malformed states fail closed", async (t) => {
  const f = fixture(t);
  for (const [i, status] of ["cancelled", "unexpected"].entries()) {
    const item = checkpoint(`req_state_${i}`);
    const answer = f.ui.ask(item.request, item.response);
    const form = await f.pending(i + 1);
    form.state = { status } as FormDetail["state"];
    if (status === "cancelled") assert.equal(await answer, "reject");
    else await assert.rejects(answer, /state is invalid/);
  }
});

test("parallel checkpoints in one session and other sessions remain independent", async (t) => {
  const f = fixture(t);
  const items = [checkpoint("req_a"), checkpoint("req_b"), checkpoint("req_child", "ses_child")];
  const answers = items.map((item) => f.ui.ask(item.request, item.response));
  await f.pending(3);
  const forms = f.created.map((item) => f.forms.get(item.id!)!);
  f.answer(forms[0], "reject");
  assert.equal(await answers[0], "reject");
  assert.equal(f.ui.pendingCount, 2);
  f.answer(forms[1], "allow");
  f.answer(forms[2], "allow");
  assert.deepEqual(await Promise.all(answers), ["reject", "allow", "allow"]);
});

test("cancelSession invalidates only current requests, leaves sibling and future asks valid", async (t) => {
  const f = fixture(t);
  const first = checkpoint("req_cancel_a");
  const sibling = checkpoint("req_cancel_b", "ses_b");
  const firstAnswer = f.ui.ask(first.request, first.response);
  const siblingAnswer = f.ui.ask(sibling.request, sibling.response);
  await f.pending(2);
  f.ui.cancelSession(["ses_a"]);
  assert.equal(await firstAnswer, "reject");
  f.answer(f.forms.get(f.created[1].id!)!, "allow");
  assert.equal(await siblingAnswer, "allow");
  const next = checkpoint("req_cancel_next");
  const nextAnswer = f.ui.ask(next.request, next.response);
  f.answer(await f.pending(3), "allow");
  assert.equal(await nextAnswer, "allow");
  assert.equal(f.cancelled.includes(f.created[1].id!), false);
});

test("cancellation during start prevents a form from being created", async (t) => {
  const f = fixture(t);
  const item = checkpoint("req_start_race");
  const answer = f.ui.ask(item.request, item.response);
  f.ui.cancelSession(["ses_a"]);
  assert.equal(await answer, "reject");
  assert.equal(f.created.length, 0);
});

test("cancellation during create rejects promptly and cleans up late creation", async (t) => {
  const f = fixture(t);
  const gate = deferred<FormInfo>();
  let input: SessionFormCreateInput | undefined;
  f.client.session.form.create = async (value) => {
    input = jsonCopy(value);
    return gate.promise;
  };
  const item = checkpoint("req_create_race");
  const answer = f.ui.ask(item.request, item.response);
  await until(() => input !== undefined);
  f.ui.cancelSession(["ses_a"]);
  assert.equal(await answer, "reject");
  const initialCancels = f.cancelled.length;
  gate.resolve(input as FormInfo);
  await until(() => f.cancelled.length > initialCancels);
  assert.ok(f.cancelled.every((id) => id === input!.id));
  assert.equal(f.ui.pendingCount, 0);
});

test("connection is lazy and cancellation while connecting creates no form", async (t) => {
  const f = fixture(t);
  const gate = deferred<NativeFormsClient>();
  let calls = 0;
  const ui = new NativeApprovalUI({
    client: () => {
      calls++;
      return gate.promise;
    },
    requestTimeoutMs: 100,
    pollIntervalMs: 2,
  });
  t.after(() => ui.close());
  await ui.start();
  assert.equal(calls, 0);
  const item = checkpoint("req_connect_race");
  const answer = ui.ask(item.request, item.response);
  await until(() => calls === 1);
  ui.cancelSession(["ses_a"]);
  assert.equal(await answer, "reject");
  gate.resolve(f.client);
  const next = checkpoint("req_connect_next");
  const nextAnswer = ui.ask(next.request, next.response);
  f.answer(await f.pending(), "allow");
  assert.equal(await nextAnswer, "allow");
  assert.equal(calls, 1);
});

test("create transport failure and get timeout throw without allowing, abort and clean up", async (t) => {
  const f = fixture(t, { requestTimeoutMs: 15 });
  const originalCreate = f.client.session.form.create;
  f.client.session.form.create = async () => {
    throw new Error("Transport failed");
  };
  const broken = checkpoint("req_create_error");
  await assert.rejects(f.ui.ask(broken.request, broken.response), /Transport failed/);
  f.client.session.form.create = originalCreate;
  let signal: AbortSignal | undefined;
  f.client.session.form.get = async (_, options) => {
    signal = options?.signal;
    return new Promise(() => undefined);
  };
  const hung = checkpoint("req_get_timeout");
  await assert.rejects(f.ui.ask(hung.request, hung.response), /timed out/);
  assert.equal(signal?.aborted, true);
  assert.ok(f.cancelled.includes(f.created[0].id!));
  assert.equal(f.ui.pendingCount, 0);
});

test("create timeout remains a technical failure and cancels a delayed server-side form", async (t) => {
  const f = fixture(t, { requestTimeoutMs: 15 });
  const gate = deferred<FormInfo>();
  let input: SessionFormCreateInput | undefined;
  let signal: AbortSignal | undefined;
  f.client.session.form.create = async (value, options) => {
    input = jsonCopy(value);
    signal = options?.signal;
    return gate.promise;
  };
  const item = checkpoint("req_create_timeout");
  await assert.rejects(f.ui.ask(item.request, item.response), /timed out/);
  assert.equal(signal?.aborted, true);
  const initialCancels = f.cancelled.length;
  gate.resolve(input as FormInfo);
  await until(() => f.cancelled.length > initialCancels);
  assert.ok(f.cancelled.every((id) => id === input!.id));
});

test("close during create rejects the checkpoint and cleans late completion", async (t) => {
  const f = fixture(t);
  const gate = deferred<FormInfo>();
  let input: SessionFormCreateInput | undefined;
  f.client.session.form.create = async (value) => {
    input = jsonCopy(value);
    return gate.promise;
  };
  const item = checkpoint("req_close_create");
  const answer = f.ui.ask(item.request, item.response);
  await until(() => input !== undefined);
  await f.ui.close();
  assert.equal(await answer, "reject");
  const initialCancels = f.cancelled.length;
  gate.resolve(input as FormInfo);
  await until(() => f.cancelled.length > initialCancels);
});

test("human response has no total timeout while API calls remain responsive", async (t) => {
  const f = fixture(t, { requestTimeoutMs: 15 });
  const item = checkpoint("req_patient");
  let settled = false;
  const answer = f.ui.ask(item.request, item.response).then((decision) => {
    settled = true;
    return decision;
  });
  const form = await f.pending();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(settled, false);
  f.answer(form, "allow");
  assert.equal(await answer, "allow");
});

test("close rejects pending answers, cancels only owned forms and prevents new asks", async (t) => {
  const f = fixture(t);
  const foreign = {
    id: "frm_foreign",
    sessionID: "ses_a",
    title: "Other plugin",
    fields: [],
    state: { status: "pending" },
  } as unknown as FormDetail;
  f.forms.set(foreign.id, foreign);
  const item = checkpoint("req_close");
  const answer = f.ui.ask(item.request, item.response);
  await f.pending();
  await f.ui.close();
  assert.equal(await answer, "reject");
  assert.equal(foreign.state.status, "pending");
  assert.equal(f.cancelled.includes(foreign.id), false);
  const next = checkpoint("req_closed");
  await assert.rejects(f.ui.ask(next.request, next.response), /closed/);
});

test("malformed or replayed classifier decisions never create an approval", async (t) => {
  const f = fixture(t);
  const item = checkpoint("req_binding");
  await assert.rejects(
    f.ui.ask(item.request, { ...item.response, binding_digest: "b".repeat(64) }),
    /different checkpoint/,
  );
  await assert.rejects(
    f.ui.ask(item.request, { ...item.response, decision: "allow" }),
    /bound classifier deny/,
  );
  const mutated = jsonCopy(item.request);
  mutated.current_call.arguments.command = "something else";
  await assert.rejects(f.ui.ask(mutated, item.response), /bound classifier deny/);
  const answer = f.ui.ask(item.request, item.response);
  const form = await f.pending();
  await assert.rejects(f.ui.ask(item.request, item.response), /already submitted/);
  f.answer(form, "reject");
  assert.equal(await answer, "reject");
  await assert.rejects(f.ui.ask(item.request, item.response), /already submitted/);
  assert.equal(f.created.length, 1);
});

test("bad client shape and invalid timing configuration fail explicitly", async () => {
  const bad = new NativeApprovalUI({ client: {} as NativeFormsClient });
  await assert.rejects(bad.start(), /unavailable/);
  assert.throws(
    () => new NativeApprovalUI({ client: {} as NativeFormsClient, requestTimeoutMs: 0 }),
    /positive finite/,
  );
});
