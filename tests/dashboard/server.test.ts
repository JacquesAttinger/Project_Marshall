// Last edited: 2026-10-03 18:27 CDT
// The dashboard server on port 0 over a temp MARSHALL_HOME: security headers, the Host allow-list
// on every route, the Origin check on Kill, each Kill outcome, the hand-off route, a plain 500,
// the missing-DB page, and one kill per identifier at a time. launchd is faked as Linux; Linear
// and the session roster are injected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import { parseConfig } from "../../src/config.ts";
import { createDashboardContext, type DashboardContext } from "../../src/dashboard/context.ts";
import { hostAllowed, originMatches, startDashboard } from "../../src/dashboard/server.ts";
import { migrate, openDb } from "../../src/db/index.ts";
import { killFlag } from "../../src/master/types.ts";
import { dbPath, handoffPath } from "../../src/paths.ts";
import { writePidfile } from "../../src/pidfile.ts";
import { getFlag } from "../../src/scheduler/store.ts";
import { recordingLogger, type TempHome, useTempHome } from "../helpers.ts";
import { fakeClient } from "../scheduler/fake-client.ts";
import { seedClaim } from "../scheduler/helpers.ts";

let home: TempHome;
let server: Server<undefined> | null;
let context: DashboardContext;
let base: string;
let host: string;

function makeDb(): void {
  mkdirSync(dirname(dbPath()), { recursive: true });
  const db = openDb(dbPath());
  migrate(db);
  seedClaim(db, { issueId: "uuid-1", slot: 0, state: "implementing", identifier: "TOD-1" });
  seedClaim(db, { issueId: "uuid-2", slot: 1, state: "resolving", identifier: "TOD-2" });
  seedClaim(db, { issueId: "uuid-3", slot: 2, state: "awaiting_human", identifier: "TOD-3" });
  db.close();
}

function start(ctx?: DashboardContext): void {
  const config = parseConfig({ workspace: "w", teamId: "t", repoPath: home.dir, maxAgents: 3 });
  context =
    ctx ??
    createDashboardContext({
      config,
      apiKey: "key",
      log: recordingLogger().log,
      connect: async () => fakeClient([]),
      listSessions: async () => [],
      daemon: { platform: "linux" },
    });
  server = startDashboard({ port: 0, context, workspace: "w", log: recordingLogger().log });
  host = `127.0.0.1:${server.port}`;
  base = `http://${host}`;
}

beforeEach(() => {
  home = useTempHome();
  server = null;
});

afterEach(async () => {
  await server?.stop(true);
  context?.close();
  home.restore();
});

const kill = (id: string, origin: string | null = base, hostHeader = host) =>
  fetch(`${base}/kill/${id}`, {
    method: "POST",
    headers: { Host: hostHeader, ...(origin ? { Origin: origin } : {}) },
  });

describe("guards", () => {
  test("host allow-list and origin match", () => {
    expect(hostAllowed("127.0.0.1:7474")).toBe(true);
    expect(hostAllowed("localhost")).toBe(true);
    expect(hostAllowed("mac.tail1234.ts.net")).toBe(true);
    expect(hostAllowed("evil.com")).toBe(false);
    expect(hostAllowed("ts.net.evil.com")).toBe(false);
    expect(hostAllowed("[::1]:7474")).toBe(false);
    expect(hostAllowed(null)).toBe(false);
    expect(originMatches("https://mac.tail1234.ts.net", "mac.tail1234.ts.net")).toBe(true);
    expect(originMatches("http://127.0.0.1:7474", "127.0.0.1:7474")).toBe(true);
    expect(originMatches("https://evil.com", "127.0.0.1:7474")).toBe(false);
    expect(originMatches("null", "127.0.0.1:7474")).toBe(false);
    expect(originMatches(null, "127.0.0.1:7474")).toBe(false);
  });

  test("GET / is 200 with every security header", async () => {
    makeDb();
    start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("TOD-1");
  });

  test("a foreign Host is 403 on every route", async () => {
    makeDb();
    start();
    for (const path of ["/", "/sections", "/handoff/TOD-3", "/assets/dashboard.js", "/nope"]) {
      const res = await fetch(`${base}${path}`, { headers: { Host: "evil.com" } });
      expect(res.status).toBe(403);
    }
    expect((await kill("TOD-1", "http://evil.com", "evil.com")).status).toBe(403);
  });

  test("Kill with a foreign or missing Origin is 403 and sets nothing", async () => {
    makeDb();
    writePidfile(new Date());
    start();
    expect((await kill("TOD-1", "https://evil.com")).status).toBe(403);
    expect((await kill("TOD-1", null)).status).toBe(403);
    const db = openDb(dbPath());
    expect(getFlag(db, killFlag("uuid-1"))).toBeNull();
    db.close();
  });
});

describe("kill", () => {
  test("live orchestrator: flag, then already requested; unknown 404, parked 409, resolver 409", async () => {
    makeDb();
    writePidfile(new Date());
    start();
    const first = await kill("TOD-1");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      message: expect.stringMatching(/kill requested/),
    });
    const db = openDb(dbPath());
    expect(getFlag(db, killFlag("uuid-1"))).not.toBeNull();
    db.close();
    expect(await (await kill("tod-1")).json()).toMatchObject({
      ok: true,
      message: expect.stringMatching(/already requested/),
    });
    expect((await kill("TOD-9")).status).toBe(404);
    expect((await kill("TOD-3")).status).toBe(409);
    expect((await kill("TOD-2")).status).toBe(409);
    expect((await kill("not-an-id!")).status).toBe(404);
    // The section cache was invalidated: the next page shows the request.
    expect(await (await fetch(`${base}/`)).text()).toContain("Kill requested");
  });

  test("two taps at once run one kill", async () => {
    let calls = 0;
    let release = () => {};
    const fake: DashboardContext = {
      view: async () => ({ kind: "no_db", problem: "missing", daemonRunning: false, now: "" }),
      handoffHtml: () => null,
      kill: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ kind: "already_requested", identifier: "TOD-1" });
        });
      },
      close: () => {},
    };
    start(fake);
    const both = Promise.all([kill("TOD-1"), kill("tod-1")]);
    await Bun.sleep(20);
    release();
    const statuses = (await both).map((r) => r.status);
    expect(statuses).toEqual([200, 200]);
    expect(calls).toBe(1);
  });
});

describe("pages and errors", () => {
  test("/sections returns four sections and their hashes; assets are served typed", async () => {
    makeDb();
    start();
    const body = (await (await fetch(`${base}/sections`)).json()) as {
      sections: Record<string, string>;
      hashes: Record<string, string>;
    };
    expect(Object.keys(body.sections).sort()).toEqual(["agents", "needsYou", "queue", "strip"]);
    expect(Object.keys(body.hashes).sort()).toEqual(["agents", "needsYou", "queue", "strip"]);
    const js = await fetch(`${base}/assets/dashboard.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("/sections");
    const css = await fetch(`${base}/assets/dashboard.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("the hand-off route renders a fixture with <script> as text; bad ids are 404", async () => {
    makeDb();
    mkdirSync(dirname(handoffPath("TOD-3")), { recursive: true });
    writeFileSync(
      handoffPath("TOD-3"),
      "<!-- Last edited -->\n# TOD-3\n\n<script>alert(1)</script>\n",
    );
    start();
    const res = await fetch(`${base}/handoff/TOD-3`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("Last edited");
    expect((await fetch(`${base}/handoff/TOD-4`)).status).toBe(404);
    expect((await fetch(`${base}/handoff/..%2F..%2Fmarshall`)).status).toBe(404);
  });

  test("a throwing handler is a plain 500 with no stack", async () => {
    const fake: DashboardContext = {
      view: async () => {
        throw new Error("secret detail at /Users/x");
      },
      handoffHtml: () => null,
      kill: async () => ({ kind: "no_db" }),
      close: () => {},
    };
    start(fake);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("no DB yet: the page says to start the daemon, and Kill is 503", async () => {
    start();
    const text = await (await fetch(`${base}/`)).text();
    expect(text).toContain("Start the daemon once");
    expect((await kill("TOD-1")).status).toBe(503);
  });
});
