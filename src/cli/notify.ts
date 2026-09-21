// Last edited: 2026-09-21 01:00 CDT
// `marshall notify test <event|all>`: send one sample push per event type through the real
// mapping and the real ntfy endpoint, for the phone-in-hand acceptance test. Nothing is written
// to the DB.

import { loadConfig, loadEnv } from "../config.ts";
import {
  type EventRow,
  type Fetch,
  isPushEvent,
  mapEvent,
  PUSH_EVENTS,
  sendPush,
} from "../notify.ts";

const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
  blocked: { why: "review_exhausted" },
  over_budget: { why: "over_budget" },
  crashed: { why: "crashed" },
  rate_limited: { until: "2026-09-21T09:00:00.000Z" },
};

export function sampleRow(event: string, id: number): EventRow {
  return {
    id,
    ts: new Date().toISOString(),
    type: `master.${event}`,
    issueId: "sample-issue",
    agentId: "agent-0",
    payload: SAMPLE_PAYLOADS[event] ?? {},
    identifier: "CB-0",
    title: `Sample ${event.replaceAll("_", " ")} push from marshall notify test`,
    slot: 0,
  };
}

export interface NotifyTestOptions {
  event: string;
  configPath?: string;
  fetch?: Fetch;
}

export async function runNotifyTest(opts: NotifyTestOptions): Promise<number> {
  const events = opts.event === "all" ? Object.keys(PUSH_EVENTS) : [opts.event];
  const bad = events.filter((e) => !isPushEvent(e));
  if (bad.length > 0) {
    console.error(
      `marshall notify test: unknown event ${bad.join(", ")}. One of: ${Object.keys(PUSH_EVENTS).join(", ")}, all`,
    );
    return 2;
  }
  const prefix = loadEnv().NTFY_TOPIC_PREFIX;
  if (!prefix) {
    console.error("marshall notify test: NTFY_TOPIC_PREFIX is not set in .env");
    return 1;
  }
  const workspace = loadConfig(opts.configPath).workspace;
  const fetchFn: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  let failed = 0;
  for (const [i, event] of events.entries()) {
    const push = mapEvent(sampleRow(event, i + 1), { prefix, workspace });
    if (!push) continue;
    const ok = await sendPush(push, fetchFn);
    if (!ok) failed += 1;
    console.log(
      `${ok ? "sent  " : "FAILED"} ${push.topic.padEnd(prefix.length + 10)} ${push.title}`,
    );
  }
  return failed > 0 ? 1 : 0;
}
