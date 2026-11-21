---
paths:
  - "shared/design-tokens/**"
  - "client/tailwind.config.js"
  - "client/src/index.css"
  - "client/src/**/*.tsx"
  - "admin/src/app/globals.css"
  - "admin/src/**/*.tsx"
  - "client/tests/design-lint.test.ts"
  - "client/tests/design-tokens-bridge.test.ts"
  - "admin/tests/design-tokens-bridge.test.ts"
---

# Design system: tokens, bridges and the design lint

The desktop app and the admin console share one set of design tokens (approved by the owner on
2026-11-21; the proposal with its reference table, contrast table and component samples is the
owner's 「デザインシステム案」 folder of that date, `tokens.md` / `components.html`). The look of
both is today's app with its variations removed, not a redesign. This file says where values
live, how screens use them, and what CI holds.

## Three layers

| Layer | Where | What | Who uses it |
|---|---|---|---|
| 1 raw values | `shared/design-tokens/primitives.css` | colour steps (`--zinc-50`, `--blue-600`, …), sizes (`--dim-8`), type sizes (`--type-13`) | layer 2 only |
| 2 semantic tokens | `shared/design-tokens/theme.css` | `--color-surface`, `--color-text-muted`, `--color-danger-bg`, `--radius-control`, `--font-size-body`, `--size-control`, `--z-dialog`, … | components, through the bridges' class names |
| 3 components | `client/src/shared/ui`, `admin/src/components/ui` | buttons, callouts, dialogs, … | screens |

- The single source is `shared/design-tokens/tokens.json` (W3C Design Tokens / DTCG):
  `primitive` → `semantic.scale` (theme-independent), `semantic.light` / `semantic.dark`,
  `semantic.density.comfortable`, and `data` (user-chosen colours). `build.mjs` generates
  `primitives.css`, `theme.css` and the two bridges; never edit those by hand.
- Light is on `:root`, dark under `.dark` (both apps put the class on `<html>`). Density: the
  admin sets `<html data-density="comfortable">` (14px body, 36px controls, 16px button padding);
  the app uses the default (13px, 32px). That is the only per-app difference: no app overrides a
  token value.
- State colours come in sets (`-text`, `-bg`, `-border`, `-icon`; hover / active where needed):
  danger, warning, info, success, ai, paused (stopped by a person: grey), failed (stopped by a
  failure: red), awaiting (awaiting approval: amber), selected, disabled, readonly (「閲覧のみ」).
  Emphasis is one primary blue (`#1264a3`, dark buttons `#1b71b8`) under separate names: `primary`,
  `link`, `selected-*`, `focus-ring`, `unread` (the one new-item mark), `thing-task`. AI is violet.
  Amber means warning and awaiting approval only (others later). Type: six steps `caption` 11 ·
  `small` 12 · `body` 13 (admin 14) · `title` 15 · `heading` 17 · `page` 20, each with line height
  and weight.
- `--data-*` (`--data-department-default`, the 12 department colours) are data, not meaning:
  components take a user-chosen colour through `style` and never mix it with semantic colours.
  Avatar hues, file-type and syntax colours are data too.
- Not in the CSS: `color-scheme` (each app sets its own today) and the second primary option
  (the owner chose blue).

## Adding or changing a token

1. Edit `tokens.json` (a new semantic name needs both `light` and `dark`; reference primitives
   as `{primitive.color.blue-600}`; add a primitive only when a semantic token uses it).
2. `node shared/design-tokens/build.mjs`, commit the generated files with it.
3. `build.mjs --check` (CI) fails when a generated file is stale or a text / UI colour pair in
   its `PAIRS` falls below WCAG AA (4.5:1 text, 3:1 icons, borders, focus ring, button shapes).
   The input border (`border-control`) keeps today's light tone (owner decision 3) and is not in
   `PAIRS`. A new foreground / background combination gets a pair.

## The bridges (add-only)

- **App** (`client/`, Tailwind 3): `tailwind-bridge.app.cjs` is a preset in
  `client/tailwind.config.js`; `client/src/index.css` imports `primitives.css` and `theme.css`, so
  every window (all load `src/main.tsx`) and the UI preview pages get them, and Vite bundles them
  into the packaged app. Colours are `rgb(var(--color-…-rgb) / <alpha-value>)`, so
  `bg-primary/10` works (but see the lint: use a set's `-bg` instead). Class names:
  `bg-bg`, `bg-surface-raised`, `text-text-muted`, `border-border-control`, `bg-danger-bg`,
  `text-body`, `font-strong`, `rounded-control`, `shadow-pop`, `z-dialog`, `opacity-disabled`,
  `h-control`, `size-icon`, `px-control-x` / `py-toast-y` (every padding axis), `ring-focus`,
  `duration-fast`, …
- **Admin** (`admin/`, Tailwind 4 + shadcn/ui): `globals.css` imports `primitives.css`,
  `theme.css`, then `tailwind-bridge.admin.css`, which defines shadcn's variables
  (`--background`, `--primary`, `--muted-foreground`, `--ring`, `--radius`, `--destructive`, …)
  as aliases of the semantic tokens, registers them for Tailwind as before, and adds the same
  semantic class names. Every `@theme` block there is `inline reference`: a utility reads the
  variable directly and Tailwind emits no variable of its own, so nothing it emits can share a
  name with a token. Sizes and paddings are spacing names (`--spacing-control-x`), so every axis
  and property works (`px-control-x`, `py-toast-y`, `h-control`, `size-icon`). The Dockerfile
  copies `shared/` into the build stage.
- **Token variables never shadow Tailwind 4's own** (`--font-weight-medium`, `--text-sm`,
  `--radius-md`, `--shadow-sm`, `--spacing`, …): theme.css is unlayered and would win over
  Tailwind's theme layer. Hence `--weight-*` (not `--font-weight-*`), `--font-size-*`,
  `--font-family-*`. `admin/tests/design-tokens-bridge.test.ts` fails on a clash with Tailwind 4's
  default theme or with a registration the bridge does not mark `reference`.
- **Nothing changed on screen when they arrived**: existing names keep their values.
  `client/tests/design-tokens-bridge.test.ts` fails when the app bridge redefines any theme value
  the app had without it, and when a bridge references a variable the tokens do not define;
  `admin/tests/design-tokens-bridge.test.ts` holds every shadcn variable and `--radius` to the
  value the admin had before the tokens, light and dark (its `TODAY` table).
  Names already taken keep their old meaning until their screens move: in the app `surface`
  (`bg-surface` = #fff in both themes) and `border` (#e0e0e0); `accent`, `ink`, `text-primary`,
  `sidebar-bg`, … stay as they are. In the admin, every shadcn colour except light `--card` /
  `--popover` keeps today's value (`ADMIN_SHADCN` in `build.mjs`: `keep` and a `later:` comment
  naming its token), and `--font-sans` stays Geist. Dropping a `keep` is a visible change: do it
  in the PR of that component and update `TODAY` there (owner decisions 2 black primary buttons →
  primary, 6 admin font → system font, 7 admin radius 8px; the admin's `rounded-md` 6px, shadcn
  `accent` = sunken).
- Do not change what an existing Tailwind name means (`text-sm`, `rounded-lg`, `accent`) to reach
  a token: move the screen to the semantic name instead.

## Design lint (ratchet)

`shared/design-tokens/design-lint.mjs` reads every string in `client/src` and `admin/src`
(`.ts` / `.tsx`, tests excluded; class attributes, `cn()` arguments and class constants alike)
with the TypeScript parser. It judges only a class's body: variants (`dark:`, `hover:`,
`data-[state=open]:`, `aria-[selected=true]:`, `group-data-[…]:`, `has-[:focus]:`, `[&>svg]:`)
are never findings. Rules: `palette-color` (`bg-zinc-100`; the palettes are read from Tailwind 4's
default theme and Tailwind 3's colours, so `olive`, `taupe`, … are included), `white-black`,
`color-literal` (`bg-[#fff]`), `inline-color` (a colour literal in `style={{…}}`),
`arbitrary-value` (`text-[13px]`, `z-[60]`, `bg-(--x)`; a token — `w-[var(--size-menu)]`,
`w-(--size-menu)` — or a Radix run-time measure `(--radix-…)` is fine), `type-scale`
(`text-xs…`), `radius-scale` (anything but `rounded-small / control / card / full / none`, sides
included), `shadow-scale` (anything but `shadow-card / pop / dialog / none`; any `drop-shadow-*`,
`inset-shadow-*`, `text-shadow-*`), `z-index` (`z-50`), `opacity-scale` (`opacity-40`; 0 and 100
fine), `color-opacity` (`bg-warning/10`).

- **No new raw values.** Today's findings (2026-11-21: app 6,872, admin 1,235) are recorded per
  file and rule in `design-lint-baseline.txt`. CI ("Lint (changed files)", step "Design tokens and
  design lint") fails when a rule gains findings, when the tree differs from the baseline without
  it being updated (the list only shrinks), and (`--base <sha>`) when the committed baseline was
  raised against the base commit's (unless the lint itself — `design-lint.mjs` or `theme.css` —
  changed in the same change: a new rule may find more, and that PR says so).
- **Renames and splits** move counts: when a file gains findings of a rule and at least as many
  of that rule went away elsewhere in the same change (`git mv`, a component split out of a file),
  it is a move, not growth. `--update` writes it; more than went away is growth and refused.
- After fixing, renaming or splitting: `node shared/design-tokens/design-lint.mjs --update` (it
  never raises a total) and commit the baseline with the change. `--list <file>` shows each
  finding with its line and the name to use instead.
- **A legitimate exception** (a layout width that has no token, a third-party value): a comment
  `design-lint-allow <rule>[, <rule>] -- <reason>` on the line or the line above, e.g.
  `{/* design-lint-allow arbitrary-value -- the column matches the PDF page width */}`. Without a
  reason it does not count. Prefer a token when the value recurs.
- `client/tests/design-lint.test.ts` holds the rules to the failing examples in
  `shared/design-tokens/lint-examples/` (the admin's warning callout: 5 findings; an app dialog:
  13; Tailwind 4 spellings: 10) and the passing one, the exception comment, the ratchet's
  arithmetic (growth, rename, split) and the CLI (`--update`, `--base`).

### Known gaps

- Style objects outside a JSX `style` attribute (`const s = { color: '#fff' }` passed later) and
  numeric inline styles (`style={{ zIndex: 60, fontSize: 13 }}`) are not judged.
- Class names built from pieces (`` `text-${size}` ``, `bg-${tone}-50`) are invisible: only whole
  tokens in a string are read. Prefer a map of complete class names.
- `.css` files (`client/src/index.css`, `admin/src/app/globals.css`, component CSS) are not
  scanned; their raw values move to tokens with the component that uses them.
- Prose strings that happen to look like a class (`"z-10"` in a message) count as findings; reword
  or record an exception.
- Layout values (`w-[420px]`, `grid-cols-[…]`, `max-h-[60vh]`) are findings until there are
  layout tokens; record a real one-off with `design-lint-allow`.
## Order of the next PRs (from the proposal)

- **P1**: danger vs ordinary actions and the confirm dialog (red only for delete / remove; focus,
  Tab inside, Esc, no confirm on Enter during IME composition, focus returned); screens unreadable
  in dark (login, server setup, company picker, input dialog, menus, change review); visible
  focus, selected, disabled, busy and field errors.
- **P2**: primary button, callouts (+ an admin `Alert`), status badges (the three stopped
  states), dialog surface / scrim / title, checkbox, switch, select, menus, toasts, empty /
  loading / error states.
- **P3**: the remaining arbitrary type sizes to the six steps, radius and shadow details, tables,
  list rows.
- Each moves screens to the semantic names (and lowers the baseline); a component PR that changes
  how something looks says so in its owner summary.
