// Last edited: 2026-09-20 16:05 CDT
// Put the hand-off text into a PR body between the two marker comments. Everything outside the
// markers is byte-identical afterwards, so `Closes <URL>` and human edits survive, and a re-post
// of the same text is a no-op (`changed: false`) that skips `gh pr edit`.

import {
  HANDOFF_END,
  HANDOFF_HEADING,
  HANDOFF_PLACEHOLDER,
  HANDOFF_START,
  type SpliceAction,
} from "./types.ts";

export type { SpliceAction } from "./types.ts";

export type SpliceResult =
  | {
      ok: true;
      body: string;
      action: SpliceAction;
      /** False when the body already held exactly this text. */
      changed: boolean;
      /** Later marker pairs deleted wholesale; only the first is kept. */
      removedDuplicates: number;
    }
  | { ok: false; reason: "markers_unbalanced"; detail: string };

interface Markers {
  start: string;
  end: string;
}

const DEFAULT_MARKERS: Markers = { start: HANDOFF_START, end: HANDOFF_END };

function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    out.push(at);
  }
  return out;
}

/** `[startIndex, endIndex]` per well-formed pair, or null when starts and ends do not alternate. */
function pairs(body: string, markers: Markers): [number, number][] | null {
  const starts = indicesOf(body, markers.start);
  const ends = indicesOf(body, markers.end);
  if (starts.length !== ends.length) return null;
  const out: [number, number][] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] as number;
    const end = ends[i] as number;
    const next = starts[i + 1];
    if (end < start || (next !== undefined && next < end)) return null;
    out.push([start, end]);
  }
  return out;
}

/** The line that holds `## Hand-off`, as `[lineStart, lineEnd)` offsets, or null. */
function headingSpan(body: string): [number, number] | null {
  const m = new RegExp(`^${HANDOFF_HEADING}[ \\t]*\\r?$`, "m").exec(body);
  return m ? [m.index, m.index + m[0].length] : null;
}

function insertAfterHeading(body: string, block: string, eol: string): SpliceResult {
  const span = headingSpan(body);
  if (!span) {
    const sep = body.length === 0 ? "" : body.endsWith("\n") ? eol : `${eol}${eol}`;
    const next = `${body}${sep}${HANDOFF_HEADING}${eol}${eol}${block}${eol}`;
    return { ok: true, body: next, action: "appended", changed: true, removedDuplicates: 0 };
  }
  const after = span[1];
  // The first non-blank line after the heading: the placeholder, or human text to keep below.
  const rest = body.slice(after);
  const m = /^(\r?\n)*([^\r\n]*)/.exec(rest);
  const firstLine = m?.[2] ?? "";
  if (firstLine.trim() === HANDOFF_PLACEHOLDER) {
    const lineStart = after + (m?.[0].length ?? 0) - firstLine.length;
    const next = `${body.slice(0, lineStart)}${block}${body.slice(lineStart + firstLine.length)}`;
    return {
      ok: true,
      body: next,
      action: "filled_placeholder",
      changed: true,
      removedDuplicates: 0,
    };
  }
  // One blank line on each side of the block; the human text below is otherwise untouched.
  const below = rest.replace(/^(\r?\n)+/, "");
  const tail = below.length > 0 ? `${eol}${eol}${below}` : eol;
  const next = `${body.slice(0, after)}${eol}${eol}${block}${tail}`;
  return {
    ok: true,
    body: next,
    action: "inserted_after_heading",
    changed: true,
    removedDuplicates: 0,
  };
}

/** Replace the first pair's inside; drop every later pair (and one line break after each). */
function replaceInside(
  body: string,
  found: [number, number][],
  text: string,
  markers: Markers,
  eol: string,
): SpliceResult {
  let next = body;
  for (let i = found.length - 1; i >= 1; i--) {
    const [start, end] = found[i] as [number, number];
    let cut = end + markers.end.length;
    if (next.startsWith(eol, cut)) cut += eol.length;
    next = `${next.slice(0, start)}${next.slice(cut)}`;
  }
  const [start, end] = found[0] as [number, number];
  const innerStart = start + markers.start.length;
  next = `${next.slice(0, innerStart)}${eol}${text}${eol}${next.slice(end)}`;
  return {
    ok: true,
    body: next,
    action: "replaced",
    changed: next !== body,
    removedDuplicates: found.length - 1,
  };
}

export function spliceHandoff(
  body: string,
  text: string,
  markers: Markers = DEFAULT_MARKERS,
): SpliceResult {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const content = text.replace(/\r\n/g, "\n").trim().replace(/\n/g, eol);
  const found = pairs(body, markers);
  if (found === null) {
    return {
      ok: false,
      reason: "markers_unbalanced",
      detail: `${indicesOf(body, markers.start).length} start / ${indicesOf(body, markers.end).length} end markers`,
    };
  }
  if (found.length === 0) {
    const block = `${markers.start}${eol}${content}${eol}${markers.end}`;
    return insertAfterHeading(body, block, eol);
  }
  return replaceInside(body, found, content, markers, eol);
}
