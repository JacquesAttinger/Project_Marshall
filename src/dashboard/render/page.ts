// Last edited: 2026-10-03 18:34 CDT
// The page shell and the four swappable sections. `GET /` renders the whole page; `GET /sections`
// returns the same four sections as HTML strings plus a hash each, so the client swaps only the
// ones that changed. No inline script or style anywhere: the CSP allows only /assets.

import type { DashboardView } from "../context.ts";
import { html, raw, type SafeHtml } from "../html.ts";
import { renderAgents } from "./agents.ts";
import { renderNeedsYou } from "./needs-you.ts";
import { renderQueue } from "./queue.ts";
import { daemonPill, renderStrip } from "./strip.ts";

export const SECTION_NAMES = ["strip", "needsYou", "agents", "queue"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];
export type Sections = Record<SectionName, string>;

const NO_DB_TEXT = {
  missing: "There is no database yet. Start the daemon once (marshall start) to create it.",
  outdated:
    "The database is older than this code. Start the daemon once (marshall start) to update it.",
};

function noDbSections(view: Extract<DashboardView, { kind: "no_db" }>): Sections {
  const waiting = (title: string) =>
    html`<h2>${title}</h2><p class="empty">Waiting for the database.</p>`.value;
  return {
    strip:
      html`<div class="pills">${daemonPill(view.daemonRunning)}<span class="pill pill-warn">Database not ready</span></div>`
        .value,
    needsYou:
      html`<h2>Needs you</h2><p class="note note-warn note-section">${NO_DB_TEXT[view.problem]}</p>`
        .value,
    agents: waiting("Agents"),
    queue: waiting("Queue"),
  };
}

export function renderSections(view: DashboardView, workspace: string): Sections {
  if (view.kind === "no_db") return noDbSections(view);
  const { data } = view;
  const now = new Date(data.now);
  return {
    strip: renderStrip(data.strip, now).value,
    needsYou: renderNeedsYou(data.needsYou, now, data.queue.error).value,
    agents: renderAgents(data.agents).value,
    queue: renderQueue(data.queue, workspace, now).value,
  };
}

/** A short, stable fingerprint per section: the client skips a swap when it matches. */
export function sectionHashes(sections: Sections): Sections {
  const out = {} as Sections;
  for (const name of SECTION_NAMES) out[name] = Bun.hash(sections[name]).toString(36);
  return out;
}

/** One section wrapper. `sections` holds strings this module's own templates produced. */
function section(name: SectionName, sections: Sections, hashes: Sections, cls: string): SafeHtml {
  return html`<section id="s-${name}" class="${cls}" data-hash="${hashes[name]}">${raw(sections[name])}</section>`;
}

export function renderPage(sections: Sections, now: string): string {
  const hashes = sectionHashes(sections);
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Marshall</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/dashboard.css">
<script src="/assets/dashboard.js" defer></script>
</head>
<body>
<header class="top">
<div class="brand">Marshall</div>
${section("strip", sections, hashes, "strip")}
<p id="updated" class="updated" data-at="${now}" role="status">Updated just now</p>
</header>
<main class="layout">
${section("needsYou", sections, hashes, "col-a")}
<div class="col-b">
${section("agents", sections, hashes, "")}
${section("queue", sections, hashes, "")}
</div>
</main>
</body>
</html>`}`;
}
