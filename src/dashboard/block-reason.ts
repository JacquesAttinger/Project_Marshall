// Last edited: 2026-10-03 18:27 CDT
// Why a Blocked card is blocked, in one sentence. New rows carry the Linear comment on the block
// event; older rows have only the short `why` code, so an implementer outcome reads its reason
// back from implement.json and anything else is mapped to plain words.

import type { Database } from "bun:sqlite";
import { IMPLEMENT_OUTCOMES, readImplementStatus } from "../implement/status.ts";
import { latestBlockEvent } from "../scheduler/store.ts";

const PLAIN_WORDS: Record<string, string> = {
  blocked: "The implementer reported it is blocked.",
  review_exhausted: "The review rounds ran out before the PR was clean.",
  tests_red: "The tests stayed red.",
  killed: "Stopped on request (Kill).",
  over_budget: "The issue clock ran out.",
  exhausted: "The agent stalled or crashed too often, and a fresh restart was not possible.",
  crashed: "Marshall crashed while driving this issue.",
  bounce_limit: "It bounced back the maximum number of times.",
  missing_sections: "The hand-off package was missing required sections.",
  launch_failed: "The agent could not be launched.",
  classifier_failed: "The planner could not classify the issue.",
  rebase_ci_timeout: "CI never finished after the rebase.",
  resolver_ci_red: "The conflict resolver reported green, but CI is red.",
  resolver_failed: "The conflict resolver run failed.",
  resolver_gave_up: "The conflict resolver could not get the PR green.",
  resolver_launch_failed: "The conflict resolver could not start.",
  resolver_missing: "The conflict resolver run is missing.",
  resolver_over_budget: "The conflict resolver ran out of time.",
  resolver_stalled: "The conflict resolver stalled.",
};

/** A `why` code in plain words. `start_failed:<stage>` keeps its stage. */
export function plainWhy(why: string | null): string {
  if (!why) return "Blocked, with no reason recorded.";
  const known = PLAIN_WORDS[why];
  if (known) return known;
  if (why.startsWith("start_failed:")) {
    return `Marshall could not start it (${why.slice("start_failed:".length)}).`;
  }
  return `Blocked (${why.replaceAll("_", " ")}).`;
}

/** `reason` as its own sentence: capital first letter, a full stop at the end. */
function sentence(reason: string): string {
  const text = reason.trim();
  const capped = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function isImplementOutcome(why: string): boolean {
  return (IMPLEMENT_OUTCOMES as readonly string[]).includes(why);
}

/** The block reason for one issue: the event's comment, implement.json's reason, or plain words. */
export function blockReason(db: Database, issueId: string, identifier: string): string {
  const event = latestBlockEvent(db, issueId);
  if (!event) return plainWhy(null);
  if (event.comment) return event.comment;
  if (event.why && isImplementOutcome(event.why)) {
    try {
      const reason = readImplementStatus(identifier)?.reason;
      if (reason) return `${plainWhy(event.why)} ${sentence(reason)}`;
    } catch {
      // A half-written implement.json: the plain words still say why.
    }
  }
  return plainWhy(event.why);
}
