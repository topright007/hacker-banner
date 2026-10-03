import assert from "node:assert/strict";
import { test } from "node:test";
import { Plugin } from "@opencode/plugin";
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Cause, Effect, Exit } from "effect";
import { ActionRejectedError } from "../src/gates.js";
import { withActionRejection } from "../src/runtime.js";

type NativeHook = (event: any) => Effect.Effect<void, unknown>;

function fixture() {
  const hooks = new Map<string, NativeHook>();
  const domain = {};
  const ctx = {
    app: {},
    location: {},
    options: {},
    agent: domain,
    aisdk: domain,
    command: domain,
    event: domain,
    experimental: { terminal: domain },
    generate: domain,
    integration: { connect: domain, oauth: domain, command: domain },
    mcp: domain,
    model: domain,
    permission: domain,
    plugin: domain,
    provider: domain,
    reference: domain,
    rpc: domain,
    session: domain,
    shell: domain,
    skill: domain,
    storage: domain,
    tool: {
      hook(name: string, callback: NativeHook) {
        return Effect.sync(() => {
          hooks.set(name, callback);
          return { dispose: Effect.sync(() => hooks.delete(name)) };
        });
      },
    },
    vcs: { branch: domain },
    websearch: domain,
    worktree: domain,
  } as unknown as EffectPlugin.Context;
  return { ctx, hooks };
}

test("Promise pre refusal becomes a recoverable Tool.Error and a later call still runs", async () => {
  const f = fixture();
  let cleaned = false;
  const denied = new ActionRejectedError({
    phase: "pre_tool_call",
    tool: "read",
    cause: "user_rejected",
    classifierReason: "Test classifier refusal",
  });
  const plugin = withActionRejection(
    Plugin.define({
      id: "bridge-test",
      async setup(ctx) {
        const registration = await ctx.tool.hook("execute.before", async (event) => {
          if (event.id === "denied") throw denied;
        });
        return async () => {
          cleaned = true;
          await registration.dispose();
        };
      },
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(f.ctx);
        const before = f.hooks.get("execute.before")!;
        const refused = yield* Effect.exit(before({ id: "denied" }));
        assert.ok(Exit.isFailure(refused));
        assert.equal(Cause.hasDies(refused.cause), false);
        const failure = refused.cause.reasons.find(Cause.isFailReason);
        assert.ok(failure?.error instanceof ToolError);
        assert.equal(failure.error.message, denied.message);
        yield* before({ id: "next-call" });
      }),
    ),
  );
  assert.equal(cleaned, true);
  assert.equal(f.hooks.size, 0);
});

test("unexpected pre failures and post failures remain defects", async () => {
  const f = fixture();
  const bug = new Error("unexpected plugin failure");
  const postRefusal = new ActionRejectedError({
    phase: "post_tool_call",
    tool: "read",
    cause: "internal_failure",
  });
  const plugin = withActionRejection(
    Plugin.define({
      id: "bridge-defect-test",
      async setup(ctx) {
        await ctx.tool.hook("execute.before", async () => {
          throw bug;
        });
        await ctx.tool.hook("execute.after", async () => {
          throw postRefusal;
        });
      },
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(f.ctx);
        for (const [name, expected] of [
          ["execute.before", bug],
          ["execute.after", postRefusal],
        ] as const) {
          const result = yield* Effect.exit(f.hooks.get(name)!({}));
          assert.ok(Exit.isFailure(result));
          assert.equal(Cause.hasFails(result.cause), false);
          const defect = result.cause.reasons.find(Cause.isDieReason);
          assert.equal(defect?.defect, expected);
        }
      }),
    ),
  );
});

test("native cancellation of a pending Promise hook stays an interruption", async () => {
  const f = fixture();
  let started!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plugin = withActionRejection(
    Plugin.define({
      id: "bridge-interrupt-test",
      async setup(ctx) {
        await ctx.tool.hook("execute.before", async () => {
          started();
          await pending;
        });
      },
    }),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(f.ctx);
          yield* Effect.promise(async () => {
            const controller = new AbortController();
            const running = Effect.runPromiseExit(f.hooks.get("execute.before")!({}), {
              signal: controller.signal,
            });
            await waiting;
            controller.abort();
            const result = await running;
            assert.ok(Exit.isFailure(result));
            assert.equal(Cause.hasInterruptsOnly(result.cause), true);
          });
        }),
      ),
    );
  } finally {
    release();
  }
});
