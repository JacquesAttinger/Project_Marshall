// Last edited: 2026-10-03 18:27 CDT
// One panel per agent slot: the issue, its phase, model, elapsed time, tokens, last action, a
// "needs you" flag, and the two-tap Kill button. Idle slots say so.

import { formatElapsed } from "../../cli/status-ops.ts";
import type { AgentInfo, AgentSlot } from "../data.ts";
import { html, type SafeHtml } from "../html.ts";
import { formatTokens } from "./format.ts";

function killControl(agent: AgentInfo): SafeHtml {
  if (!agent.killable) {
    return html`<p class="note">Resolver running: Kill cannot stop it. Use <code>marshall stop</code>.</p>`;
  }
  if (agent.killRequested) {
    return html`<p class="note">Kill requested. The orchestrator stops it on its next pulse.</p>`;
  }
  return html`<div class="kill-row"><button class="kill" type="button" data-kill="${agent.identifier}">Kill</button><span class="kill-msg" data-kill-msg="${agent.identifier}" role="status"></span></div>`;
}

function fact(label: string, value: string): SafeHtml {
  return html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function panel(slot: number, agent: AgentInfo): SafeHtml {
  const phase = agent.subPhase ? `${agent.phase} · ${agent.subPhase}` : agent.phase;
  return html`<article class="panel${agent.needsYou ? " panel-flag" : ""}" data-id="${agent.identifier}">
<header class="row"><span class="slot">Slot ${slot + 1}</span><a class="issue" href="${agent.url}" target="_blank" rel="noopener noreferrer">${agent.identifier}</a><span class="badge badge-run">${phase}</span></header>
${agent.title && html`<p class="title">${agent.title}</p>`}
${agent.needsYou && html`<p class="flag">Needs you: ${agent.needsYou}</p>`}
<dl class="facts">${fact("Model", agent.model)}${fact("Elapsed", formatElapsed(agent.elapsedMs))}${fact("Tokens", agent.tokens === null ? "-" : formatTokens(agent.tokens))}</dl>
${agent.lastAction && html`<p class="last"><span class="muted">Last:</span> ${agent.lastAction}</p>`}
${killControl(agent)}
</article>`;
}

export function renderAgents(slots: AgentSlot[]): SafeHtml {
  const busy = slots.filter((s) => s.agent).length;
  const panels = slots.map(({ slot, agent }) =>
    agent
      ? panel(slot, agent)
      : html`<article class="panel panel-idle"><span class="slot">Slot ${slot + 1}</span> · idle</article>`,
  );
  return html`<h2>Agents <span class="count">${busy}</span></h2><div class="panels">${panels}</div>`;
}
