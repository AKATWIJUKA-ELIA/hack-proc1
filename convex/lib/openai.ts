// One place for every OpenAI call, so caps and model choices are auditable.
//
// Verified 2026-08-27 against GET /v1/models: this project has access to
// exactly one model, `gpt-5`. A model the project cannot reach fails at
// runtime with a 403 model_not_found, never at typecheck — so re-check this
// list rather than assuming a newer id works.
export const EXTRACTION_MODEL = "gpt-5";
export const PARSING_MODEL = "gpt-5";

// Cost guards (PLAN.md §8 risk register): no API credits are provided for
// runtime inference, so every call is bounded on both sides. Input is clipped
// before it is sent, and output is capped by the request itself — an unbounded
// completion is the expensive failure mode, because a model that rambles bills
// for every token of it.
export const MAX_INPUT_CHARS = 6_000;
// gpt-5 spends reasoning tokens against this same budget, so a cap tuned to
// the size of the JSON alone gets consumed before the answer is written and
// the response comes back truncated — which surfaced in production as
// "Parse failed: Unexpected end of JSON input". Headroom for reasoning, with
// the schema still keeping the visible output small.
export const MAX_OUTPUT_TOKENS = 6_000;

export function clip(text: string, max: number = MAX_INPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

export type JsonSchema = Record<string, unknown>;

/**
 * Build an object schema that satisfies OpenAI's strict mode.
 *
 * Strict mode requires `additionalProperties: false` and a `required` array
 * listing EVERY key in `properties`, at every nesting level. Optionality is
 * expressed by making a field nullable — never by leaving it out of `required`.
 * Deriving `required` from the property names here makes that invariant
 * structural: there is no way to write a schema that violates it.
 */
export function strictObject(
  properties: Record<string, JsonSchema>,
  description?: string,
): JsonSchema {
  return {
    type: "object",
    description,
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/** A value the model may legitimately not find: nullable, but still required. */
export function nullable(
  type: "string" | "number" | "boolean",
  description?: string,
): JsonSchema {
  return { type: [type, "null"], description };
}

/**
 * Strict mode has no dynamic-key objects (`additionalProperties` must be
 * false), so an open-ended map travels as an explicit list of pairs.
 */
export function nullablePairs(description?: string): JsonSchema {
  return {
    type: ["array", "null"],
    description,
    items: strictObject({
      key: { type: "string" },
      value: { type: "string" },
    }),
  };
}

/** Turn the pair list back into a record, dropping anything malformed. */
export function pairsToRecord(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, value: pairValue } = entry as Record<string, unknown>;
    if (typeof key === "string" && typeof pairValue === "string") {
      record[key] = pairValue;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Chat Completions with a strict JSON schema. Returns the parsed object, or
 * throws with the API's own message so the caller can record an honest failure.
 */
export async function openAiJson(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: JsonSchema;
}): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: clip(args.user) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: args.schemaName,
          strict: true,
          schema: args.schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 300)}`);
  }

  const body: unknown = await response.json();

  // Say plainly that the budget ran out, rather than letting JSON.parse fail
  // with "Unexpected end of JSON input" and sending a human hunting.
  if (finishReason(body) === "length") {
    throw new Error(
      `Model output hit the ${MAX_OUTPUT_TOKENS}-token cap before finishing. ` +
        "Raise MAX_OUTPUT_TOKENS or shorten the input.",
    );
  }

  const content = readContent(body);
  if (content === null) {
    throw new Error("OpenAI returned no message content");
  }

  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenAI returned a non-object payload");
  }
  return parsed as Record<string, unknown>;
}

/** "length" means the completion was cut off mid-answer. */
function finishReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const reason = (first as { finish_reason?: unknown }).finish_reason;
  return typeof reason === "string" ? reason : null;
}

/** Narrow the response shape rather than trusting it. */
function readContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}
