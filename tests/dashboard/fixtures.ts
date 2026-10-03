// Last edited: 2026-10-03 18:27 CDT
// Builders for the dashboard's view data, so render tests state only the field they are about.

import type { QueueReport, QueueRow } from "../../src/cli/queue.ts";
import type { AgentInfo, NeedsYouCard, StripData } from "../../src/dashboard/data.ts";

export const NOW = new Date(2026, 9, 3, 14, 0, 0);

export function strip(overrides: Partial<StripData> = {}): StripData {
  return {
    daemonRunning: true,
    counts: {
      live: 1,
      today: 4,
      window: 2,
      windowFreesAt: null,
      pausedUntil: null,
      pausedAt: null,
    },
    caps: { maxAgents: 3, dailyStartCap: 10, windowStartCap: 10, windowHours: 3 },
    queueEmpty: false,
    ...overrides,
  };
}

export function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    issueId: "uuid-17",
    identifier: "TOD-17",
    title: "End-to-end QA",
    url: "https://linear.app/w/issue/TOD-17",
    state: "implementing",
    phase: "Implementing",
    subPhase: "review cycle 2/4",
    model: "opus",
    elapsedMs: 65 * 60_000,
    tokens: 33_553,
    lastAction: "plan committed",
    needsYou: null,
    killRequested: false,
    killable: true,
    ...overrides,
  };
}

export function card(overrides: Partial<NeedsYouCard> = {}): NeedsYouCard {
  return {
    issueId: "uuid-12",
    identifier: "TOD-12",
    title: "Fix the timer",
    url: "https://linear.app/w/issue/TOD-12",
    state: "awaiting_human",
    prUrl: "https://github.com/o/r/pull/26",
    updatedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    tldr: null,
    round: null,
    hasHandoff: false,
    blockReason: null,
    ...overrides,
  };
}

export function queueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    identifier: "TOD-20",
    title: "Next thing",
    priority: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    kind: "fresh",
    bounces: 0,
    wouldStart: false,
    slot: null,
    reasons: [],
    status: "slots_full",
    ...overrides,
  };
}

export function queueReport(rows: QueueRow[], windowFreesAt: string | null = null): QueueReport {
  return {
    now: NOW.toISOString(),
    pausedUntil: null,
    pausedAt: null,
    counts: { live: 0, today: 0, window: 0, windowFreesAt, pausedUntil: null, pausedAt: null },
    caps: { maxAgents: 3, dailyStartCap: 10, windowStartCap: 10, windowHours: 3 },
    rows,
  };
}
