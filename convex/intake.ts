import { v } from "convex/values";
import { internalAction, env } from "./_generated/server";
import { internal } from "./_generated/api";
import { toMinor } from "./lib/money";
import {
  EXTRACTION_MODEL,
  openAiJson,
  strictObject,
  nullable,
  nullablePairs,
  pairsToRecord,
} from "./lib/openai";

/**
 * Step 1 of the demo spine: free text -> structured requirement spec.
 *
 * Actions call the world; mutations touch the database (PLAN.md §4). This
 * action owns the OpenAI call and nothing else — the write is a single internal
 * mutation, which is what makes the step retryable.
 */
export const extractSpec = internalAction({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.runQuery(internal.requests.loadInternal, {
      requestId: args.requestId,
    });
    if (!request) return null;

    try {
      const spec = await openAiJson({
        apiKey: env.OPENAI_API_KEY,
        model: EXTRACTION_MODEL,
        system:
          "You extract IT-equipment procurement requirements. Return only what the text states. " +
          "Never invent a budget, quantity, or delivery window that is not present.",
        user: request.rawText,
        schemaName: "requirement_spec",
        schema: strictObject({
          title: {
            type: "string",
            description: "Short label, e.g. '50 x Dell Latitude 5550'",
          },
          budgetAmount: nullable(
            "number",
            "Budget ceiling in major units, or null",
          ),
          currency: nullable(
            "string",
            "ISO 4217 code stated in the text, or null",
          ),
          deliveryWindowDays: nullable("number"),
          items: {
            type: "array",
            items: strictObject({
              description: { type: "string" },
              quantity: { type: "number" },
              unit: nullable("string"),
              specs: nullablePairs("Spec pairs such as cpu, ram, storage"),
            }),
          },
        }),
      });

      const currency =
        typeof spec.currency === "string" && spec.currency.length === 3
          ? spec.currency.toUpperCase()
          : request.currency;

      const rawItems = Array.isArray(spec.items) ? spec.items : [];
      const items = rawItems.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Record<string, unknown>;
        const description = record.description;
        const quantity = record.quantity;
        if (typeof description !== "string" || typeof quantity !== "number") {
          return [];
        }
        return [
          {
            description,
            quantity,
            unit: typeof record.unit === "string" ? record.unit : undefined,
            specs: pairsToRecord(record.specs),
          },
        ];
      });

      if (items.length === 0) {
        await ctx.runMutation(internal.requests.setStatus, {
          requestId: args.requestId,
          status: "failed",
          failureReason:
            "Could not read any line items from that description. Try naming the item and quantity.",
        });
        return null;
      }

      await ctx.runMutation(internal.requests.saveSpec, {
        requestId: args.requestId,
        title: typeof spec.title === "string" ? spec.title : request.title,
        budgetMinor:
          typeof spec.budgetAmount === "number"
            ? toMinor(spec.budgetAmount, currency)
            : undefined,
        currency,
        deliveryWindowDays:
          typeof spec.deliveryWindowDays === "number"
            ? spec.deliveryWindowDays
            : undefined,
        items,
      });
    } catch (error) {
      await ctx.runMutation(internal.requests.setStatus, {
        requestId: args.requestId,
        status: "failed",
        failureReason: `Extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    return null;
  },
});
