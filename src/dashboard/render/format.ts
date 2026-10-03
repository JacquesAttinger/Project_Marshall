// Last edited: 2026-10-03 18:27 CDT
// Small text formatters shared by the section templates: clock times, ages, token counts, and the
// PR label. Times are the laptop's local time, which is also the phone's.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `16:40` today, `Sep 30 10:51` on another day. */
export function formatClock(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hhmm(d) : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hhmm(d)}`;
}

/** `just now`, `12 min`, `3 h`, `4 d`. */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** `950`, `33.6k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `PR #26` from a GitHub pull URL, else `PR`. */
export function prLabel(url: string): string {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? `PR #${n}` : "PR";
}
