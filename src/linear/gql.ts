// Last edited: 2026-09-19 22:00 CDT
// Raw GraphQL transport for Linear. Zero deps: `fetch`, an API key, and a Zod schema per call.
// No retries here; step 07's poll loop owns retry timing.

import type { ZodType } from "zod";
import type { Logger } from "../log.ts";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
/** Below this many remaining requests in the hour, every call logs a warning. */
export const LOW_BUDGET_THRESHOLD = 200;

export interface GqlOptions {
  apiKey: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** Parsed from the `X-RateLimit-Requests-*` headers. `resetAt` is an ISO timestamp. */
export interface RateBudget {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface GraphqlErrorShape {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export class LinearError extends Error {
  override name = "LinearError";
  operation: string;
  status?: number;
  errors?: GraphqlErrorShape[];

  constructor(
    message: string,
    operation: string,
    extra: { status?: number; errors?: GraphqlErrorShape[] } = {},
  ) {
    super(message);
    this.operation = operation;
    this.status = extra.status;
    this.errors = extra.errors;
  }
}

export class LinearRateLimitError extends LinearError {
  override name = "LinearRateLimitError";
  resetAt: string | null;

  constructor(operation: string, resetAt: string | null) {
    const when = resetAt ? ` Resets at ${resetAt}.` : "";
    super(`Linear rate limit hit during ${operation}.${when}`, operation, { status: 429 });
    this.resetAt = resetAt;
  }
}

export interface Gql {
  <T>(doc: string, operationName: string, variables: object, schema: ZodType<T>): Promise<T>;
  /** Budget from the most recent response, or null before the first call. */
  readonly lastBudget: RateBudget | null;
}

function readBudget(headers: Headers): RateBudget | null {
  const limit = Number(headers.get("X-RateLimit-Requests-Limit"));
  const remaining = Number(headers.get("X-RateLimit-Requests-Remaining"));
  const reset = Number(headers.get("X-RateLimit-Requests-Reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return null;
  }
  if (limit === 0 && remaining === 0 && reset === 0) return null;
  return { limit, remaining, resetAt: new Date(reset).toISOString() };
}

async function readBody(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new LinearError(
      `Linear returned a non-JSON body for ${operation} (HTTP ${response.status})`,
      operation,
      { status: response.status },
    );
  }
}

function errorsOf(body: unknown): GraphqlErrorShape[] | null {
  if (typeof body !== "object" || body === null) return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors as GraphqlErrorShape[];
}

/** Build a `gql` function bound to one API key. Each call is one POST. */
export function createGql(opts: GqlOptions): Gql {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? LINEAR_ENDPOINT;
  let lastBudget: RateBudget | null = null;

  async function send<T>(
    doc: string,
    operationName: string,
    variables: object,
    schema: ZodType<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: opts.apiKey },
      body: JSON.stringify({ query: doc, operationName, variables }),
    });
    const budget = readBudget(response.headers);
    if (budget) lastBudget = budget;
    const ms = Math.round(performance.now() - startedAt);
    opts.log.debug("linear.request", {
      operation: operationName,
      status: response.status,
      ms,
      remaining: budget?.remaining ?? null,
    });
    if (budget && budget.remaining < LOW_BUDGET_THRESHOLD) {
      opts.log.warn("linear.budget_low", { remaining: budget.remaining, resetAt: budget.resetAt });
    }
    if (response.status === 429) {
      throw new LinearRateLimitError(operationName, budget?.resetAt ?? null);
    }
    const body = await readBody(response, operationName);
    const errors = errorsOf(body);
    if (errors) {
      const messages = errors.map((e) => e.message).join("; ");
      throw new LinearError(`Linear ${operationName} failed: ${messages}`, operationName, {
        status: response.status,
        errors,
      });
    }
    if (!response.ok) {
      throw new LinearError(
        `Linear ${operationName} failed: HTTP ${response.status}`,
        operationName,
        {
          status: response.status,
        },
      );
    }
    const parsed = schema.safeParse((body as { data?: unknown }).data);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new LinearError(
        `Unexpected response shape from ${operationName}: ${detail}`,
        operationName,
      );
    }
    return parsed.data;
  }

  return Object.defineProperty(send, "lastBudget", {
    get: () => lastBudget,
    enumerable: true,
  }) as Gql;
}
