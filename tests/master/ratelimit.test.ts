// Last edited: 2026-09-21 02:15 CDT

import { describe, expect, test } from "bun:test";
import { parseResetTime, pauseUntilFor } from "../../src/master/ratelimit.ts";

const now = new Date(2026, 8, 20, 14, 0, 0);
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 20 + dayOffset, h, m, 0, 0);

describe("parseResetTime", () => {
  test.each([
    ["You've hit your usage limit. Resets at 3pm.", at(15)],
    ["Resets at 3:30pm", at(15, 30)],
    ["resets 15:45", at(15, 45)],
    ["Limit reached. Resets at 12am.", at(0, 0, 1)],
    ["Resets at 2pm (America/Chicago)", at(14, 0, 1)],
  ])("%s", (details, expected) => {
    const parsed = parseResetTime(details, now);
    if (expected.getTime() - now.getTime() > 6 * 3_600_000) expect(parsed).toBeNull();
    else expect(parsed?.getTime()).toBe(expected.getTime());
  });

  test("returns null without a time, on nonsense hours, and for a time more than 6 h out", () => {
    expect(parseResetTime(undefined, now)).toBeNull();
    expect(parseResetTime("You've hit your usage limit.", now)).toBeNull();
    expect(parseResetTime("Resets at 27:00", now)).toBeNull();
    expect(parseResetTime("Resets at 1pm", now)).toBeNull();
  });
});

describe("pauseUntilFor", () => {
  const config = { rateLimitProbeMinutes: 30 };

  test("uses the parsed time when there is one", () => {
    expect(pauseUntilFor("Resets at 3pm", now, config)).toEqual({ until: at(15), parsed: true });
  });

  test("falls back to the probe delay otherwise", () => {
    expect(pauseUntilFor(undefined, now, config)).toEqual({
      until: new Date(now.getTime() + 30 * 60_000),
      parsed: false,
    });
  });
});
