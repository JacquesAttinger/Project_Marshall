# Fix castling through check

<!-- Last edited: 2026-09-20 11:00 CDT -->

**TLDR:** The king can castle while a square it crosses is attacked.
The move generator skips the attack check for the middle square.
One condition fixes it.

## Where to find it

Play a game, put a bishop on the b-file, and try to castle queenside.

## Orientation

Area: the engine. Part: move generation. Section: `castlingMoves()`.

## What is wrong and why

`castlingMoves()` checks the king's start and end squares but not the one between.

## Likely touched files

- `src/engine/moves.ts` — the castling branch
- `tests/engine/moves.test.ts` — a new case

## Plan

1. Add the middle-square attack check.
2. Add the test.

## Decisions made alone

- Kept the fix in `castlingMoves()` rather than a new helper: one condition does not need one.

## Out of scope found

- **En passant across a pin** — same family of bug, separate rule.

## Verification

`bun test tests/engine/moves.test.ts` passes with the new case.
