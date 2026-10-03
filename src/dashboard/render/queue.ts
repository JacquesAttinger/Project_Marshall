// Last edited: 2026-10-03 18:34 CDT
// The queue: the pickable issues in pickup order and what the next tick does with each, from the
// structured status codes (never by parsing the reason text).

import type { QueueRow, QueueStatus } from "../../cli/queue.ts";
import { linearIssueUrl } from "../../linear/url.ts";
import type { QueueData } from "../data.ts";
import { html, type SafeHtml } from "../html.ts";
import { formatClock } from "./format.ts";

const PRIORITY: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

const STATUS: Record<QueueStatus, [string, string]> = {
  next_start: ["next start", "status-ok"],
  slots_full: ["slots full", "status-wait"],
  daily_cap: ["daily cap", "status-wait"],
  window_cap: ["window cap", "status-wait"],
  paused: ["paused", "status-wait"],
  rate_limited: ["rate-limited", "status-wait"],
  live: ["live", "status-run"],
  bounce_limit: ["bounce limit", "status-bad"],
  human_only: ["human only", "status-muted"],
};

function statusText(row: QueueRow, windowFreesAt: string | null, now: Date): string {
  const [label] = STATUS[row.status];
  if (row.status === "next_start" && row.slot !== null) return `${label} · slot ${row.slot + 1}`;
  if (row.status === "window_cap" && windowFreesAt) {
    return `${label} · frees ${formatClock(windowFreesAt, now)}`;
  }
  return label;
}

export function renderQueue(queue: QueueData, workspace: string, now: Date): SafeHtml {
  const head = html`<h2>Queue${queue.report && html` <span class="count">${queue.report.rows.length}</span>`}</h2>`;
  const stale =
    queue.error &&
    html`<p class="note note-warn note-section">Linear: ${queue.error}.${queue.report && queue.fetchedAt && html` Showing the list from ${formatClock(queue.fetchedAt, now)}.`}</p>`;
  if (!queue.report) return html`${head}${stale}`;
  const { rows, counts } = queue.report;
  if (rows.length === 0) return html`${head}${stale}<p class="empty">Nothing pickable.</p>`;
  const items = rows.map((row) => {
    const [, tone] = STATUS[row.status];
    return html`<li class="q-row"><a class="issue" href="${linearIssueUrl(workspace, row.identifier)}" target="_blank" rel="noopener noreferrer">${row.identifier}</a><span class="q-title">${row.title}</span><span class="q-meta"><span class="prio">${PRIORITY[row.priority] ?? row.priority}</span>${row.kind === "bounce" && html`<span class="badge">bounce #${row.bounces + 1}</span>`}<span class="status ${tone}">${statusText(row, counts.windowFreesAt, now)}</span></span></li>`;
  });
  return html`${head}${stale}<ol class="queue">${items}</ol>`;
}
