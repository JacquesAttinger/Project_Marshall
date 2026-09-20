// Last edited: 2026-09-19 22:45 CDT

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createGql,
  LINEAR_ENDPOINT,
  LinearError,
  LinearRateLimitError,
} from "../../src/linear/gql.ts";
import { Viewer } from "../../src/linear/queries.ts";
import { recordingLogger } from "../helpers.ts";
import { fakeLinear, graphqlErrors, httpStatus, RESET_AT_MS, viewerData } from "./fake-linear.ts";

/** Await a rejection and hand back the error, typed. */
async function rejection<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (err) {
    return err as E;
  }
  throw new Error("expected the promise to reject");
}

function setup(handlers = {}) {
  const fake = fakeLinear(handlers);
  const { log, lines } = recordingLogger();
  const gql = createGql({ apiKey: "lin_test", log, fetchImpl: fake.fetchImpl });
  return { fake, gql, lines };
}

describe("createGql transport", () => {
  test("posts the document with the Authorization header and operationName", async () => {
    const { fake, gql } = setup();
    const data = await gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    expect(data.viewer.organization.urlKey).toBe("chessbuddy");
    const call = fake.calls[0];
    expect(call?.headers.Authorization).toBe("lin_test");
    expect(call?.headers["Content-Type"]).toBe("application/json");
    expect(call?.operationName).toBe("Viewer");
    expect(call?.query).toContain("query Viewer");
  });

  test("uses the Linear endpoint by default", async () => {
    let seenUrl = "";
    const fake = fakeLinear();
    const spy = ((url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      return fake.fetchImpl(url as string, init);
    }) as typeof fetch;
    const gql = createGql({ apiKey: "k", log: recordingLogger().log, fetchImpl: spy });
    await gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    expect(seenUrl).toBe(LINEAR_ENDPOINT);
  });

  test("parses the rate budget headers into lastBudget", async () => {
    const { fake, gql } = setup();
    expect(gql.lastBudget).toBeNull();
    fake.remaining = 1001;
    await gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    expect(gql.lastBudget).toEqual({
      limit: 2500,
      remaining: 1000,
      resetAt: new Date(RESET_AT_MS).toISOString(),
    });
  });

  test("logs linear.request on every call and linear.budget_low when remaining < 200", async () => {
    const { fake, gql, lines } = setup();
    await gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    expect(lines.filter((l) => l.event === "linear.budget_low")).toHaveLength(0);
    const request = lines.find((l) => l.event === "linear.request");
    expect(request?.fields.operation).toBe("Viewer");
    expect(request?.fields.remaining).toBe(2499);

    fake.remaining = 150;
    await gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    const low = lines.find((l) => l.event === "linear.budget_low");
    expect(low?.level).toBe("warn");
    expect(low?.fields.remaining).toBe(149);
  });
});

describe("createGql errors", () => {
  test("errors[] in the body becomes a LinearError with the messages", async () => {
    const { gql } = setup({ Viewer: () => graphqlErrors("Not authorized", "Bad field") });
    const promise = gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    await expect(promise).rejects.toBeInstanceOf(LinearError);
    await expect(promise).rejects.toThrow(/Viewer failed: Not authorized; Bad field/);
    const err = await rejection<LinearError>(promise);
    expect(err.operation).toBe("Viewer");
    expect(err.errors).toHaveLength(2);
  });

  test("HTTP 429 becomes a LinearRateLimitError carrying resetAt", async () => {
    const { gql } = setup({ Viewer: () => httpStatus(429, {}) });
    const promise = gql(Viewer.doc, Viewer.name, {}, Viewer.schema);
    await expect(promise).rejects.toBeInstanceOf(LinearRateLimitError);
    const err = await rejection<LinearRateLimitError>(promise);
    expect(err.status).toBe(429);
    expect(err.resetAt).toBe(new Date(RESET_AT_MS).toISOString());
  });

  test("a non-2xx without errors[] is a LinearError with the status", async () => {
    const { gql } = setup({ Viewer: () => httpStatus(502, {}) });
    const err = await rejection<LinearError>(gql(Viewer.doc, Viewer.name, {}, Viewer.schema));
    expect(err).toBeInstanceOf(LinearError);
    expect(err.status).toBe(502);
  });

  test("a response that does not match the schema names the operation and the path", async () => {
    const { gql } = setup({ Viewer: () => viewerData() });
    const strict = z.object({ viewer: z.object({ email: z.string() }) });
    const promise = gql(Viewer.doc, "Viewer", {}, strict);
    await expect(promise).rejects.toBeInstanceOf(LinearError);
    await expect(promise).rejects.toThrow(/Unexpected response shape from Viewer: viewer\.email/);
  });
});
