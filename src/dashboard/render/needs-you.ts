// Last edited: 2026-10-03 18:34 CDT
// The "needs you" cards: issues waiting on a person. A Needs Verification card shows the
// hand-off's TLDR and opens the full package on demand; a Blocked card shows why.

import { AWAITING_HUMAN, BLOCKED } from "../../scheduler/index.ts";
import type { DashboardData, NeedsYouCard } from "../data.ts";
import { html, renderMarkdown, type SafeHtml } from "../html.ts";
import { formatAge, prLabel } from "./format.ts";

const STATE_LABELS: Record<string, [string, string]> = {
  [AWAITING_HUMAN]: ["Needs Verification", "badge-wait"],
  [BLOCKED]: ["Blocked", "badge-bad"],
  rebasing: ["Rebasing", "badge-run"],
};

function body(card: NeedsYouCard): SafeHtml {
  if (card.state === BLOCKED) {
    // Marshall's Linear comment is Markdown; render it through the same sanitizer as the hand-off.
    return html`<div class="reason">${renderMarkdown(card.blockReason ?? "")}</div>`;
  }
  if (card.state !== AWAITING_HUMAN) {
    return html`<p class="reason">Rebased on the base branch and pushed; waiting on CI.</p>`;
  }
  const handoff =
    card.hasHandoff &&
    html`<details data-handoff="${card.identifier}"><summary>Show hand-off</summary><div class="handoff" data-handoff-body="${card.identifier}"><p class="muted">Loading…</p></div></details>`;
  return html`${card.tldr && html`<div class="tldr">${renderMarkdown(card.tldr)}</div>`}${handoff}`;
}

function card(c: NeedsYouCard, now: Date): SafeHtml {
  const [label, tone] = STATE_LABELS[c.state] ?? [c.state, "badge-run"];
  const age = formatAge(now.getTime() - Date.parse(c.updatedAt));
  const links = [
    c.prUrl &&
      html`<a href="${c.prUrl}" target="_blank" rel="noopener noreferrer">${prLabel(c.prUrl)}</a>`,
    html`<a href="${c.url}" target="_blank" rel="noopener noreferrer">Linear</a>`,
  ].filter(Boolean) as SafeHtml[];
  return html`<article class="card card-${c.state}" data-id="${c.identifier}">
<header class="row"><a class="issue" href="${c.url}" target="_blank" rel="noopener noreferrer">${c.identifier}</a><span class="badge ${tone}">${label}</span>${c.round !== null && c.round > 1 && html`<span class="badge">Round ${c.round}</span>`}<span class="age">${age}</span></header>
${c.title && html`<p class="title">${c.title}</p>`}
${body(c)}
<p class="links">${links.map((l, i) => html`${i > 0 && " · "}${l}`)}</p>
</article>`;
}

export function renderNeedsYou(
  section: DashboardData["needsYou"],
  now: Date,
  linearError: string | null,
): SafeHtml {
  const unchecked =
    !section.checkedAgainstLinear &&
    html`<p class="note note-section">Not checked against Linear (${linearError ?? "not loaded"}), so issues that are already Done may show.</p>`;
  const cards =
    section.cards.length === 0
      ? html`<p class="empty">Nothing needs you.</p>`
      : section.cards.map((c) => card(c, now));
  return html`<h2>Needs you <span class="count">${section.cards.length}</span></h2>${unchecked}${cards}`;
}
