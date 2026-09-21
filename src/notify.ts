// Last edited: 2026-09-20 23:50 CDT
// ntfy pushes for the six master events that need a human (spec 7, 9). A tailer over the `events`
// table with a persisted cursor: nothing calls it from `emit()`, so the state machine stays
// pure over the DB and a push that fails never touches a claim. One topic per agent slot,
// one for the orchestrator. Hand-off text never leaves the laptop: identifier, title, link only.

import type { Database } from "bun:sqlite";
import type { Env } from "./config.ts";
import type { Logger } from "./log.ts";
import { getFlag, setFlag } from "./scheduler/store.ts";

export const NTFY_BASE_URL = "https://ntfy.sh";
export const NOTIFY_CURSOR_FLAG = "notify_cursor";
/** A POST that keeps failing is retried on later ticks this many times, then skipped. */
export const MAX_ATTEMPTS = 3;
/** Rows read per tick. A backlog drains over a few ticks instead of one long one. */
const BATCH = 50;

export type PushPriority = "high" | "default";

/** The six events, with the topic family, the priority, and whether a Linear link goes on. */
export const PUSH_EVENTS = {
  finished: { topic: "agent", priority: "default", link: true, word: "finished" },
  blocked: { topic: "agent", priority: "high", link: true, word: "blocked" },
  over_budget: { topic: "agent", priority: "high", link: true, word: "over budget" },
  crashed: { topic: "marshall", priority: "high", link: true, word: "crashed" },
  rate_limited: { topic: "marshall", priority: "default", link: false, word: "rate limited" },
  rate_limit_resumed: {
    topic: "marshall",
    priority: "default",
    link: false,
    word: "rate limit resumed",
  },
} as const satisfies Record<
  string,
  { topic: "agent" | "marshall"; priority: PushPriority; link: boolean; word: string }
>;

export type PushEvent = keyof typeof PUSH_EVENTS;

export function isPushEvent(name: string): name is PushEvent {
  return Object.hasOwn(PUSH_EVENTS, name);
}

/** One `events` row joined with what the claim knows about its issue. */
export interface EventRow {
  id: number;
  ts: string;
  type: string;
  issueId: string | null;
  agentId: string | null;
  payload: Record<string, unknown>;
  identifier: string | null;
  title: string | null;
  slot: number | null;
}

export interface Push {
  topic: string;
  title: string;
  body: string;
  priority: PushPriority;
  click?: string;
}

export interface TopicOpts {
  prefix: string;
  /** The Linear workspace slug, for the click-through link. */
  workspace: string;
}

export function agentTopic(prefix: string, slot: number): string {
  return `${prefix}-agent-${slot}`;
}

export function marshallTopic(prefix: string): string {
  return `${prefix}-marshall`;
}

function slotOf(row: EventRow): number | null {
  if (row.slot !== null) return row.slot;
  const m = /^agent-(\d+)$/.exec(row.agentId ?? "");
  return m ? Number(m[1]) : null;
}

/** The push for one row, or null for an event that stays badge-only (phase changes, stalls, ...). */
export function mapEvent(row: EventRow, opts: TopicOpts): Push | null {
  const name = row.type.startsWith("master.") ? row.type.slice("master.".length) : null;
  if (!name || !isPushEvent(name)) return null;
  const spec = PUSH_EVENTS[name];
  const identifier = row.identifier ?? row.issueId ?? "issue";
  const slot = slotOf(row);
  const topic =
    spec.topic === "agent" && slot !== null
      ? agentTopic(opts.prefix, slot)
      : marshallTopic(opts.prefix);
  const lines = [row.title ?? identifier];
  const why = row.payload.why;
  if (
    typeof why === "string" &&
    (name === "blocked" || name === "over_budget" || name === "crashed")
  ) {
    lines.push(`why: ${why}`);
  }
  const until = row.payload.until;
  if (name === "rate_limited" && typeof until === "string") lines.push(`paused until ${until}`);
  const push: Push = {
    topic,
    title: `${identifier} ${spec.word}`,
    body: lines.join("\n"),
    priority: spec.priority,
  };
  if (spec.link && row.identifier) {
    push.click = `https://linear.app/${opts.workspace}/issue/${row.identifier}`;
  }
  return push;
}

interface RawRow {
  id: number;
  ts: string;
  type: string;
  issue_id: string | null;
  agent_id: string | null;
  payload: string | null;
  identifier: string | null;
  title: string | null;
  slot: number | null;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Master events past `afterId`, oldest first, each joined with its claim. */
export function eventsAfter(db: Database, afterId: number, limit = BATCH): EventRow[] {
  return db
    .query<RawRow, [number, number]>(
      `SELECT e.id, e.ts, e.type, e.issue_id, e.agent_id, e.payload,
              c.identifier, c.title, c.slot
       FROM events e LEFT JOIN claims c ON c.issue_id = e.issue_id
       WHERE e.id > ? AND e.type LIKE 'master.%'
       ORDER BY e.id LIMIT ?`,
    )
    .all(afterId, limit)
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      issueId: r.issue_id,
      agentId: r.agent_id,
      payload: parsePayload(r.payload),
      identifier: r.identifier,
      title: r.title,
      slot: r.slot,
    }));
}

export function maxEventId(db: Database): number {
  const row = db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get();
  return row?.id ?? 0;
}

export function readCursor(db: Database): number | null {
  const raw = getFlag(db, NOTIFY_CURSOR_FLAG);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function writeCursor(db: Database, id: number): void {
  setFlag(db, NOTIFY_CURSOR_FLAG, String(id));
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** POST one push to ntfy. Resolves true on a 2xx. Never throws. */
export async function sendPush(push: Push, fetchFn: Fetch, baseUrl = NTFY_BASE_URL) {
  const headers: Record<string, string> = { Title: push.title, Priority: push.priority };
  if (push.click) headers.Click = push.click;
  try {
    const res = await fetchFn(`${baseUrl}/${push.topic}`, {
      method: "POST",
      headers,
      body: push.body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface NotifierDeps {
  db: Database;
  env: Env;
  workspace: string;
  log: Logger;
  fetch?: Fetch;
  baseUrl?: string;
}

export interface Notifier {
  /** True when a topic prefix is configured. */
  enabled: boolean;
  /** Read new events, push what maps, advance the cursor. Returns how many pushes were sent. */
  tick(): Promise<number>;
  /** Start ticking every `intervalMs`. Ticks never overlap. */
  start(intervalMs?: number): void;
  stop(): void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const prefix = deps.env.NTFY_TOPIC_PREFIX;
  const enabled = Boolean(prefix && prefix.length > 0);
  if (!enabled) deps.log.info("notify.disabled", { reason: "NTFY_TOPIC_PREFIX is not set" });
  const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const attempts = new Map<number, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  /** `sent`, `retry` (leave the cursor here), or `skipped` (gave up; move on). */
  async function deliver(row: EventRow, push: Push): Promise<"sent" | "retry" | "skipped"> {
    if (await sendPush(push, fetchFn, deps.baseUrl)) {
      attempts.delete(row.id);
      deps.log.info("notify.pushed", { eventId: row.id, type: row.type, topic: push.topic });
      return "sent";
    }
    const n = (attempts.get(row.id) ?? 0) + 1;
    attempts.set(row.id, n);
    if (n < MAX_ATTEMPTS) {
      deps.log.warn("notify.push_failed", { eventId: row.id, type: row.type, attempt: n });
      return "retry";
    }
    attempts.delete(row.id);
    deps.log.error("notify.push_skipped", { eventId: row.id, type: row.type, attempts: n });
    return "skipped";
  }

  async function tick(): Promise<number> {
    if (!enabled || !prefix) return 0;
    let cursor = readCursor(deps.db);
    if (cursor === null) {
      // First run: nothing that happened before the notifier existed is pushed.
      cursor = maxEventId(deps.db);
      writeCursor(deps.db, cursor);
      return 0;
    }
    let sent = 0;
    for (const row of eventsAfter(deps.db, cursor)) {
      const push = mapEvent(row, { prefix, workspace: deps.workspace });
      if (push) {
        const outcome = await deliver(row, push);
        if (outcome === "retry") break;
        if (outcome === "sent") sent += 1;
      }
      cursor = row.id;
      writeCursor(deps.db, cursor);
    }
    return sent;
  }

  return {
    enabled,
    tick,
    start(intervalMs = 10_000) {
      if (timer || !enabled) return;
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await tick();
        } catch (err) {
          deps.log.error("notify.tick_error", { error: (err as Error).message });
        } finally {
          busy = false;
        }
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
