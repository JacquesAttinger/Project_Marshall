# CB-12 — Fix castling through check

<!-- Last edited: 2026-09-20 15:00 CDT -->

**TLDR:** The king could castle across a square under attack, which chess forbids.
`castlingMoves()` now checks the crossed square, and a test pins it.

## Where to find it

Open the app, start a new game, and play `e4 e5 Nf3 Nc6 Bc4 Bc5`.
Move a black piece so it attacks `f1`, then try to castle king-side as white: the move is now refused.

## Orientation

`apps/web/src/engine/` is the move generator; it produces the legal moves for a position.
`moves.ts` holds the per-piece generators; `castlingMoves()` at the bottom handles both castling directions.
The check inside it that skips castling out of check is the section that changed.

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

## Verification recipe

- Branch: `cb-12-fix-castling-through-check`
- PR: https://github.com/example/chessbuddy/pull/12
- Setup: `pnpm install` in `apps/web`.
- Steps:
  1. `pnpm test src/engine/moves.test.ts`
  2. `pnpm dev`, then play the sequence from "Where to find it" and try `O-O`.
- Expected:
  - PASS when step 1 prints `1 passed` for the new case.
  - PASS when step 2 shows no castling move in the move list.
