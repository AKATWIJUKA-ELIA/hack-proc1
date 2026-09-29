import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Append to the audit trail from inside the mutation that caused the event, so
 * the trail commits or rolls back with the write it describes. Never call this
 * from a separate function.
 */
export async function recordEvent(
  ctx: MutationCtx,
  args: {
    requestId?: Id<"requests">;
    kind: string;
    message: string;
    meta?: Record<string, string>;
  },
): Promise<void> {
  await ctx.db.insert("events", {
    requestId: args.requestId,
    kind: args.kind,
    message: args.message,
    meta: args.meta,
  });
}
