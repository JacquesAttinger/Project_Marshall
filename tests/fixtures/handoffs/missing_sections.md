# CB-12 — Fix castling through check

<!-- Last edited: 2026-09-20 15:00 CDT -->

**TLDR:** The king could castle across a square under attack, which chess forbids.
`castlingMoves()` now checks the crossed square, and a test pins it.

## Where to find it

Open the app, start a new game, and play `e4 e5 Nf3 Nc6 Bc4 Bc5`.
Move a black piece so it attacks `f1`, then try to castle king-side as white: the move is now refused.

## What was wrong and why

`castlingMoves()` refused castling when the king was in check but never looked at the square the king crosses.
The rule requires that square to be safe too, so a rook or bishop aiming at `f1` did not stop `O-O`.

## What the agent did

Added one `isAttacked()` call for the crossed square inside `castlingMoves()`, next to the existing one for the king's square.
No new helper; the condition is a single line.

**Files that matter**

- `apps/web/src/engine/moves.ts` — the extra `isAttacked()` check for the crossed square.
- `apps/web/src/engine/moves.test.ts` — a position where `f1` is attacked; asserts `O-O` is absent.

**Decisions made alone**

- Kept the fix in `castlingMoves()` rather than a new helper: one condition does not need one.

**Review notes (not fixed)**

- (none)

**Follow-ups proposed**

- Queen-side castling shares the code path; add a mirrored test.

