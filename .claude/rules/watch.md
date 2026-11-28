---
paths:
  - "client/shared/watch-character.ts"
  - "client/src/features/watch/**"
  - "client/tests/watch-character*"
  - "client/tests/ui/watch-character.spec.ts"
---

# The watch AI's character

The watch AI (見張り役, the orchestrator) has a small character per member, made from bundled parts
(owner decisions 2026-11-28, from the image board of that day). Stage 0: the parts, the React part
and a preview page only — it is on no screen yet; it will first show on the member's own screen.

- **One name, one place.** Its name is not decided: members read `WATCH_NAME`
  (`client/shared/thing-words.ts`, 「見張り役」 for now) and nothing else spells it. Ids, data,
  files, types, CSS classes and SVG say `watch`. `client/tests/watch-character.test.ts` fails when
  the name is written anywhere else in `client/src` / `client/shared`.
- **Chosen from the member id and a count.** `watchPartsFor({ memberId, rerolls, version })`
  (`client/shared/watch-character.ts`): cyrb53 of `v<version>:<id>[#<rerolls>]` seeds mulberry32,
  parts picked in the fixed order colour → body → head → eyes → pattern → tool. Never an email or a
  name, never `Math.random`. Storing the count (and the version) is a later stage.
- **Versioned parts.** `WATCH_PARTS_TABLES` keeps every released table; a released table and a
  released part's drawing are never edited. A new part is a new version whose table lists it, so
  everyone keeps the character they have ("版・回数" gives back any earlier one). A version the app
  does not know draws nothing (`null`), never another character. Test: the released version 1
  characters in `watch-character.test.ts`.
- **Only the bundled SVG.** The figure (`watchFigure`) is built from the tables alone; the member id
  is only hashed and never reaches the drawing. Never draw an SVG or image an AI made.
- **Sizes** 16 / 24 / 32 / 64 / 128. At 32 px and under: no pattern, no tool, no ground, cropped to
  the body, larger eyes. Look-alikes inside one company at that size are accepted (owner decision).
- **States are motion; results are words.** `idle`, `noticed`, `thinking`, `working`, `done`,
  `stale` (when several hold, the order of `WATCH_STATES` decides: the design memo §9). There is
  no mouth: the result is always the text beside it. Motion is small and slow; only `working`
  repeats (while the work lasts); under `prefers-reduced-motion` nothing moves and the posture
  alone tells the state (`tests/ui/watch-character.spec.ts`).
- **Colours are tokens**: a department colour (`--data-department-NN`, set through `style`) mixed
  with `--color-watch-paper` / `-ink` / `-tool`, grey `--color-watch-stale` when not checked lately
  (`features/watch/watch-character.css`). Light and dark both.
