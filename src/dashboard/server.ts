// Last edited: 2026-10-03 18:27 CDT
// The dashboard's HTTP server: `Bun.serve` on 127.0.0.1, reached from the phone through
// `tailscale serve`. Every route runs behind one guard (Host allow-list, security headers, a
// plain 500 on a throw); `routes` match before `fetch`, so a guard only in `fetch` would never
// run for them. Kill also checks Origin, and runs at most once per identifier at a time.

import { join } from "node:path";
import type { Server } from "bun";
import { type KillResult, killMessage, killSucceeded } from "../kill.ts";
import type { Logger } from "../log.ts";
import { type DashboardContext, IDENTIFIER } from "./context.ts";
import { renderPage, renderSections, sectionHashes } from "./render/page.ts";

export interface DashboardServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  hostname?: string;
  context: DashboardContext;
  workspace: string;
  log: Logger;
}

const ASSETS = join(import.meta.dir, "assets");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** The Host header without its port, lower-cased. IPv6 literals are refused (we bind IPv4). */
export function hostName(host: string | null): string | null {
  if (!host || host.startsWith("[")) return null;
  return (host.split(":")[0] as string).toLowerCase();
}

/** Only the names this server is reached by. A DNS-rebinding page arrives with its own name. */
export function hostAllowed(host: string | null): boolean {
  const name = hostName(host);
  if (!name) return false;
  return name === "localhost" || name === "127.0.0.1" || name.endsWith(".ts.net");
}

/** Same host, any scheme: the browser says https (tailscale serve) while this server sees http. */
export function originMatches(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function withHeaders(res: Response): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(key, value);
  return res;
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

type Handler = (req: Request & { params?: Record<string, string> }) => Response | Promise<Response>;

function guarded(log: Logger, handler: Handler): Handler {
  return async (req) => {
    if (!hostAllowed(req.headers.get("host"))) return withHeaders(text("Forbidden", 403));
    try {
      return withHeaders(await handler(req));
    } catch (err) {
      log.error("dashboard.request_failed", { url: req.url, error: (err as Error).message });
      return withHeaders(text("Internal error", 500));
    }
  };
}

const KILL_STATUS: Record<KillResult["kind"] | "no_db", number> = {
  flagged: 200,
  already_requested: 200,
  killed_directly: 200,
  no_claim: 404,
  not_live: 409,
  not_killable: 409,
  no_db: 503,
};

function killHandler(opts: DashboardServerOptions): Handler {
  const inflight = new Map<string, ReturnType<DashboardContext["kill"]>>();
  return async (req) => {
    if (!originMatches(req.headers.get("origin"), req.headers.get("host"))) {
      return text("Forbidden", 403);
    }
    const identifier = req.params?.identifier ?? "";
    if (!IDENTIFIER.test(identifier))
      return Response.json({ ok: false, message: "unknown issue" }, { status: 404 });
    const key = identifier.toUpperCase();
    let pending = inflight.get(key);
    if (!pending) {
      pending = opts.context.kill(key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const result = await pending;
      if (result.kind === "no_db") {
        return Response.json({ ok: false, message: "The database is not ready." }, { status: 503 });
      }
      opts.log.info("dashboard.kill", { identifier: key, result: result.kind });
      return Response.json(
        { ok: killSucceeded(result), message: killMessage(result) },
        { status: KILL_STATUS[result.kind] },
      );
    } catch (err) {
      opts.log.error("dashboard.kill_failed", { identifier: key, error: (err as Error).message });
      return Response.json(
        { ok: false, message: `Kill failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }
  };
}

function asset(name: string, type: string): Handler {
  return () => new Response(Bun.file(join(ASSETS, name)), { headers: { "Content-Type": type } });
}

export function startDashboard(opts: DashboardServerOptions): Server<undefined> {
  const { context, workspace, log } = opts;
  const guard = (handler: Handler) => guarded(log, handler);
  const sectionsNow = async () => {
    const view = await context.view();
    const now = view.kind === "ok" ? view.data.now : view.now;
    return { sections: renderSections(view, workspace), now };
  };
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    development: false,
    routes: {
      "/": {
        GET: guard(async () => {
          const { sections, now } = await sectionsNow();
          return new Response(renderPage(sections, now), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }),
      },
      "/sections": {
        GET: guard(async () => {
          const { sections, now } = await sectionsNow();
          return Response.json({ sections, hashes: sectionHashes(sections), now });
        }),
      },
      "/handoff/:identifier": {
        GET: guard((req) => {
          const body = context.handoffHtml(req.params?.identifier ?? "");
          if (body === null) return text("No hand-off for this issue.", 404);
          return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }),
      },
      "/kill/:identifier": { POST: guard(killHandler(opts)) },
      "/assets/dashboard.js": {
        GET: guard(asset("dashboard.js", "text/javascript; charset=utf-8")),
      },
      "/assets/dashboard.css": { GET: guard(asset("dashboard.css", "text/css; charset=utf-8")) },
    },
    fetch: guard(() => text("Not found", 404)),
    error(err) {
      log.error("dashboard.server_error", { error: err.message });
      return withHeaders(text("Internal error", 500));
    },
  });
}
