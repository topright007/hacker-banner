import type { Plugin as PromisePlugin } from "@opencode/plugin";
import { Plugin } from "@opencode/plugin/effect";
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Effect } from "effect";
import { ActionRejectedError } from "./gates.js";

type BeforeHook = (event: ToolHooks["execute.before"]) => Effect.Effect<void, ToolError>;

/** Keep a human refusal in OpenCode's recoverable tool-error channel. */
export function withActionRejection(plugin: PromisePlugin.Plugin): Plugin.Plugin {
  const adapted = fromPromise(plugin);
  return Plugin.define({
    id: adapted.id,
    effect(ctx) {
      const hook: typeof ctx.tool.hook = (name, callback) => {
        if (name !== "execute.before") return ctx.tool.hook(name, callback);
        // TypeScript cannot narrow a generic callback with its correlated name.
        const before = callback as unknown as BeforeHook;
        return ctx.tool.hook("execute.before", (event) =>
          Effect.catchDefect(before(event), (error) =>
            error instanceof ActionRejectedError
              ? Effect.fail(new ToolError({ message: error.message }))
              : Effect.die(error),
          ),
        );
      };
      // The pinned Promise adapter turns all rejected hook promises into defects.
      // Translate only deliberate pre-call refusals, preserving bugs and interrupts.
      return adapted.effect({ ...ctx, tool: { ...ctx.tool, hook } });
    },
  });
}
