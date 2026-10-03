// Last edited: 2026-10-03 18:27 CDT
// The status strip: is the daemon up, is it paused (by hand or by a rate limit), how full are the
// slots and the start caps, and is the queue empty.

import type { StripData } from "../data.ts";
import { html, type SafeHtml } from "../html.ts";
import { formatClock } from "./format.ts";

export function daemonPill(running: boolean): SafeHtml {
  return running
    ? html`<span class="pill pill-ok">Daemon running</span>`
    : html`<span class="pill pill-bad">Daemon down</span>`;
}

export function renderStrip(strip: StripData, now: Date): SafeHtml {
  const { counts, caps } = strip;
  const paused =
    counts.pausedAt &&
    html`<span class="pill pill-warn">Paused by hand since ${formatClock(counts.pausedAt, now)}</span>`;
  const limited =
    counts.pausedUntil &&
    html`<span class="pill pill-warn">Rate-limited until ${formatClock(counts.pausedUntil, now)}</span>`;
  const empty = strip.queueEmpty === true && html`<span class="pill">Queue empty</span>`;
  return html`<div class="pills">${daemonPill(strip.daemonRunning)}${paused}${limited}${empty}</div>
<p class="counts">${counts.live}/${caps.maxAgents} agents · ${counts.today}/${caps.dailyStartCap} today · ${counts.window}/${caps.windowStartCap} in ${caps.windowHours} h window</p>`;
}
