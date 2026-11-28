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
  Amber means warning (a stop the viewer has to act on included) and awaiting approval only. Type: six steps `caption` 11 ·
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
  (`bg-surface` = #fff in both themes) and `border` (#e0e0e0); `accent` (removed in P2d), `ink`, `text-primary` (the class `text-text-primary`; not the semantic `text-primary`, which is the primary blue),
  `sidebar-bg`, … stay as they are. In the admin, every shadcn colour except light `--card` /
  `--popover` and `--primary` / `--primary-foreground` (P2a) keeps today's value (`ADMIN_SHADCN`
  in `build.mjs`: `keep` and a `later:` comment naming its token), and `--font-sans` stays Geist.
  Dropping a `keep` is a visible change: do it in the PR of that component and update `TODAY`
  there, marked (owner decisions 6 admin font → system font, 7 admin radius 8px; the admin's
  `rounded-md` 6px, shadcn `accent` = sunken).
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

- **No new raw values.** Today's findings (2026-11-21: app 6,872, admin 1,235; after P2b app 6,371,
  admin 1,104; after P2c app 6,010, admin 1,078; after P2d app 5,694, admin 1,078; after P3 app 4,595, admin 977) are recorded per
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
## Danger actions and the confirm dialog (P1a, done)

- **One red**: the app's `Button variant="danger"` (`client/src/shared/ui/primitives.tsx`), the
  `ConfirmDialog` danger button, the danger items of `ContextMenu` / `MoreMenu`, and the admin's
  `Button variant="destructive"` / `DropdownMenuItem variant="destructive"` use the `danger` set
  (`bg-danger text-on-danger hover:bg-danger-hover`, menu items `text-danger-text`,
  `danger-bg-hover`). No amber, rose or `red-*` for a danger action; amber is warning only.
- **App `ConfirmDialog`** (`client/src/shared/ui/ConfirmDialog.tsx`): `role="alertdialog"` when
  `danger`, else `dialog`; `aria-modal`, labelled by the title and described by the message.
  Focus starts on 「やめる」 for `danger`, on the main action otherwise, and on the dialog itself
  with `confirmOnEnter={false}` (a dialog that can open while the member types: no stray key
  answers it). Tab / Shift+Tab wrap inside; Esc cancels and does not reach what is underneath;
  a scrim click neither closes it nor takes focus out; **nothing listens for Enter on the
  document** (Enter presses the focused button only: a key typed elsewhere, an IME conversion's
  included, never confirms). What protects someone **typing when the dialog opens** is
  `confirmOnEnter={false}` (focus on the dialog itself), not the missing document listener: a
  default dialog takes focus on a button, so the next real Enter presses it — every dialog that can
  open while the member types, or from an input's Enter keydown, must pass `confirmOnEnter={false}`.
  Focus returns to the opener; with dialogs stacked only the top one holds focus. Known gap: the
  app's document-level shortcuts (⌘K, ⌘P, ⌘⇧C) still fire while a dialog is open, and a palette
  they open loses its focus back to the dialog (the shortcut system should skip keys while an
  `aria-modal` dialog is open; later PR). Habit change: on a danger confirm, Enter now cancels
  (focus on 「やめる」) where it used to confirm (file tree Delete → Enter, chat sidebar).
  Guarded by `client/tests/ui/confirm-dialog.spec.ts` (`tests/confirm-dialog-ui.html`), with
  `keep-work.spec.ts` / `editor-panel.spec.ts` for Enter on `confirmOnEnter={false}`.
- **Admin `ConfirmDialog`** (`admin/src/components/app/confirm-dialog.tsx`, Radix): the same rules
  (Radix gives Tab and Esc); `destructive` (still the default) is an `alertdialog` that a scrim
  click does not close, focus starts on キャンセル, otherwise on the main action; focus returns to
  the opener although callers open it without a Radix trigger. `admin/tests/confirm-dialog.test.tsx`.
- Its frame and keys are the app's `Dialog` since P2c ("Dialog frames, link and selected").

## Dark-mode readability (P1b, done)

- **These screens follow the theme** (they stayed white, or always dark, before): `ContextMenu`,
  `InputDialog`, the company selector family (`features/company/components/*`: selector, empty
  state, folder / department choice, setup progress, the title bar's `CompanySwitcher` menu),
  `LoginScreen`, `ServerSetupScreen` (and its invitation-link offer), the chat's loading and
  setup boxes (`ChatAuthGate`), and `NewSkillWizard` (was always dark).
- **How the old names were replaced there** (only in these files; the old Tailwind names keep
  their fixed values for the other screens): `editor-bg` (page) → `bg-[var(--color-surface)]`
  (the semantic `surface`; the bridge has no `bg-surface` class because the app's `surface` name
  is taken), `sidebar-bg` → `bg-bg` (inputs and the grey secondary buttons on a page; menus and
  dialogs → `bg-surface-raised`), `activitybar-bg` hover → `bg-surface-sunken`, `border-border` →
  `border-[color:var(--color-border)]` (inputs: `border-border-control`), the classes
  `text-text-primary` / `text-ink` → `text-text` (bare `text-primary` is now the primary blue: use
  it only for blue icons), `text-text-secondary` / `text-ink-muted` → `text-text-muted`,
  placeholders → `text-text-subtle`, `focus:border-accent` → `focus:border-focus-border`, `accent/10` / `/20`
  (icon tiles, picked rows) → `selected-bg` / `selected-bg-hover`, red / green boxes → the
  `danger` / `success` sets, overlays → `bg-scrim`, `z-dialog` / `z-menu`, `shadow-dialog` /
  `shadow-pop`, `rounded-lg` → `rounded-control` (same 8px). Blue accent buttons → `bg-primary
  hover:bg-primary-hover text-on-primary`, `disabled:opacity-disabled`. Type sizes are untouched
  (P3). The setup progress' step circles (`bg-zinc-700` / `bg-green-500`) read in both themes
  and wait for the status PR (P2). The skill wizard's department colour stays (data).
- **What changed in light mode** (everything else is the same value): menus (`ContextMenu`, the
  name dialog) #f8f8f8 → white (`surface-raised`); inputs and the grey secondary buttons #f8f8f8 →
  #fafafa (`bg`; the page itself stays white); main text #1d1c1d → #18181b; secondary text #616061
  → #52525b; placeholders #616061 → zinc-500; lines #e0e0e0 → #e4e4e7, input borders → #d4d4d8
  (`border-control`); error text red-400 → red-700 and success green-400 → emerald-700 (their
  boxes the `-bg` / `-border` of the set); the dialog scrim 50 % → 45 % and the menu / dialog
  shadows → `shadow-pop` / `shadow-dialog`; a disabled blue button fades as a whole (opacity 0.5,
  its spinner included) instead of a paler blue fill; the skill wizard's hint box amber → info
  (grey: it is information, and amber is for warnings); the skill wizard's inputs now show the
  `focus-ring` colour (was Tailwind's default blue ring). The skill wizard itself is light in light
  mode (it was always dark).
- **Layering**: `ContextMenu` and the company switcher menu moved from `z-50` to `z-menu` (60),
  which ties with the hand-made `z-[60]` overlays (toasts, banners): between equals the page order
  decides. Acceptable because a menu closes on the next click; the overlays move to `z-toast` /
  `z-overlay` in P2.
- **Guarded by** `client/tests/ui/dark-readability.spec.ts`: for each screen, in dark mode (the
  `dark` class on `<html>`) the surface behind the main text has relative luminance < 0.05 and
  the text contrast is ≥ 4.5:1; in light mode the surface stays > 0.8 with the same contrast.
  Computed colours, not class names or pixels. Preview pages: `file-tree-ui` (menu, name dialog),
  `company-selector-ui`, `skill-layout-ui` (switcher; the chat loading box's own surface, its
  label sits on the chat pane, not moved here), `keep-work-ui` (wizard, a step not yet reached)
  and `sign-in-ui` (login, server setup; new), each reading `?theme=dark`.
- **Still on the old fixed tokens** (light in dark, or dark text on a dark surface; next screens
  to move): `App.tsx` (start-up `bg-editor-bg`), `SyncPreviewDialog`, `DiffViewer`
  (`sidebar-bg`, `activitybar-bg`, `border-border`, `text-primary` / `text-secondary`),
  `TabGroupParts` (`text-text-secondary`), the chat's `AgentInteractionCard`,
  `ChatAuthSettings`, `ChatMessageList`, `ChatConversation`, `ClaudeSignInCard`, `MessageParts`
  (`ink`, `ink-muted`, `ink-faint`, `surface-elevated`) and `ComposerAttachments`
  (`border-border`). `SyncPreviewDialog`, `DiffViewer`, `ChatAuthSettings` and `ClaudeSignInCard`
  moved in P2d (see "The deferred spots and the last white screens (P2d, done)").

## Primary actions (P2a, done)

- **One primary colour** (owner decisions 1 and 2, 2026-11-21): the one button of a screen, card or
  dialog that does what the member came to do is the `primary` set — `#1264a3` (dark `#1b71b8`),
  `on-primary` text, `primary-hover`, `primary-active`, the `focus-ring`, and the disabled fade
  `opacity-disabled`. The four colours before (the old `accent` blue, indigo, `blue-600`, black
  `zinc-900`) are gone from primary buttons.
- **App**: `PRIMARY_ACTION` (`client/src/shared/ui/buttonStyles.ts`) holds exactly those colour
  classes; a caller takes its size from `BUTTON_SIZE` (P3) and adds its shape. Used by `Button
  variant="primary"` (`primitives.tsx`, was black; every variant's focus ring is now
  `ring-focus-ring` with a `bg` offset, was indigo), `RecordPage`'s `MAIN_BUTTON` (task card,
  record pages, the tasks and records dialogs), `MailDraftCard`'s `PRIMARY` (was `blue-600`),
  `SkillDetailPanel` (was `blue-600`), `AgentLogNotice` (was indigo), and the hand-made `bg-accent`
  main actions: chat send buttons (`CodeMirrorChatInput`, `LegacyTextareaChatInput`: disabled now
  fades instead of turning grey), `ChatAuthSettings` save, `ChatSidebar` 「AIに相談する」,
  `ChoicePrompt` 「回答する」, `AgentInteractionCard`, `ToolApprovalBanner`, `ReviewRequestCard`,
  `BrokerKeyNeededCard`, `ClaudeSignInCard`, `HandoffControl`, `VoiceInputControl`,
  `TopicSwitchAsk`, `ChatMessageList` resend, `MarkdownPreviewPane` 編集, `SyncPreviewDialog`
  同期, `ContinueStepButton`, `TaskRow` accept, `ShareToDepartment`, `ShowToBundle`, `DriveFiles`
  つなぐ, `LinkDropNotice`, `ReviewSidePanel`. `ConfirmDialog`'s main action was already the set
  (P1a). A new primary button uses `Button variant="primary"` or `PRIMARY_ACTION`, never a colour
  of its own.
- **Proceed anyway is not danger**: 「バックアップに保存して進める」 (`DownloadFoldersSection`, the
  confirm's main action: nothing is lost) is primary; 「それでも作成する」 (`NewFolderDialog`, inside
  the warning callout, beside the dialog's own primary 「非公開フォルダを作成」) is an ordinary
  (secondary) button — one primary per dialog. Red stays for delete / remove (P1a).
- **Admin**: shadcn `--primary` / `--primary-foreground` are the tokens (`ADMIN_SHADCN` keeps
  dropped; `TODAY` marks them), so everything reading them turned blue: `Button` default (now
  `hover:bg-primary-hover active:bg-primary-active`, and every variant `rounded-control` 8px; height
  36px stays by density), the ordinary `ConfirmDialog`, `Badge variant="default"` (gone in P2b: owner
  role `neutral`, 「動いています」 / active grants `success`), the invite steps'
  current step, the brand mark (`brand.tsx`, `app-shell.tsx`, `permissions-view.tsx` tile), the
  "on" switches (`features-page`, `task-settings-page`) and checked boxes
  (`member-checklist`, `groups-page`, `department-members-dialog`, `place-readers-dialog`) — the
  proposal's table gives "on" the primary colour (`primary`: 主ボタン・オン・件数), so they stay —
  and the input text selection. The tooltip moved to `bg-toast text-on-toast` so it stays dark
  (it read `--primary` only to be the inverse surface). Filter toggles that used `variant="default"`
  for "picked" are `variant="selected"` since P2b.
- **Guarded by** `client/tests/ui/primary-actions.spec.ts` (light and dark: the shared Button with
  hover, an ordinary confirm, the task card's main action, the mail card, and the two proceed
  buttons not danger; computed colours against the `--color-*-rgb` tokens on `<html>`; preview
  pages `confirm-dialog-ui`, `task-card-ui` and `mail-draft-card-ui` read `?theme=dark`) and
  `admin/tests/primary-action.test.tsx` (the CSS Tailwind 4 generates for the rendered Button /
  confirm, resolved through the token files in light and dark).
- **`accent` in the app**: gone (P2c by meaning, see "Dialog frames, link and selected (P2c, done)";
  the last places in P2d), and the app's Tailwind config no longer defines it
  (`design-tokens-bridge.test.ts` fails if it comes back). Also not primary actions: the app `Switch` / `TriCheckbox` and the settings nav
  (indigo until P3, see "Sizes, type and corners (P3, done)"), `CompletedReviewBanner`'s 「変更表示中」 toggle (left).

## Callouts and status badges (P2b, done)

- **One callout per app**, drawn only from its state set (bg, border, text, icon; no `/5 /10 /15`
  opacities, no palette colour; corner `control`, padding `callout`, type `body`): the app's `Callout`
  (`client/src/shared/ui/primitives.tsx`, tones `info` · `warning` · `danger` (was `error`) · `success` ·
  `offline` (the info set + WifiSlash) · `paused` · `failed` · `awaiting`; `danger` / `failed` are
  `role="alert"` by default) and the admin's `Callout` (`admin/src/components/ui/callout.tsx`, the same
  variants without `offline`; `title`, `action`, `icon={null}`). A hand-drawn state box (a card's frame,
  a one-line notice) takes `STATE_BOX` (`client/src/shared/ui/stateStyles.ts`: bg + border of one set).
- **One status badge per app** (not pressable; corner `small`): the app's `StatusBadge` (primitives,
  `compact` for the file tree) and the admin's `Badge` (`components/ui/badge.tsx`). Variants `neutral`
  (surface-sunken / text-muted), `outline` (admin), `info`, `success`, `warning`, `danger`, `paused`,
  `failed`, `awaiting`, `ai`, `selected`, `readonly`. `paused` / `failed` / `awaiting` / `readonly` / `ai`
  carry a default icon (Pause, WarningOctagon, Hourglass, Lock, Sparkle) so the stopped states differ in
  more than colour. The admin's old names are gone: `default` (was primary blue) → by meaning,
  `secondary` → `neutral`, `destructive` → `danger`, `brand` → `selected`. `ReadOnlyBadge` and
  `RecordPage`'s `Chip` are thin wrappers of `StatusBadge`.
- **「止まっている」 by meaning** (owner decision 2026-11-21): stopped by a person → `paused` (dark grey,
  「止めています」 + who / when where known), stopped by a failure → `failed` (red, 「止まりました」 + the
  reason / fix), awaiting approval → `awaiting` (amber, 「承認を待っています」). Applied: the admin's
  「AI を止めています」 band (`stop-bar.tsx`, was red: grey, + who stopped the newest and when), Slack /
  Google `operatorStopped` badge and box, the connected services' `operator-stopped`, google-relay's
  止めています, the integrations list (`PROBLEM_STOP` / `problemBadge` in
  `admin/src/lib/integrations.ts`; the operator-stopped box on a plugin's page), the jobs' badge
  (`jobBadge`) and 「すべて止めています」 box, the app's task card run that needs a person (red 「AI が
  止まりました」; `AI_RUN_STATE_LABELS` say 止まりました), the task row's failed AI (red), the chat list's
  failed group 「止まりました」, an own key an admin stopped (「自分の鍵（管理者が止めています）」, grey), the
  approval card while pending (amber frame, Hourglass).
- **「止まっている」の色は、見た人にすることがあるかで決める** (owner decision 2026-11-22; it refines the
  one above): something to do — left alone it causes trouble — → **amber** (`warning`, with
  WarningCircle; a badge keeps the word 「止まっています」); nothing to do — someone stopped it on
  purpose and it is known — → grey `paused`; a failure → red `failed` 「止まりました」 with the reason and
  the fix (unchanged). Awaiting approval stays `awaiting`.
  **One place says the look of each meaning**: `shared/design-tokens/stop-meaning.ts` — `StopMeaning`
  (`needsAction`, `stoppedOnPurpose`, `failed`, `awaitingApproval`) → `STOP_LOOK` (the variant and the
  badge's word), pure data read by both apps. A screen says what its stop *means* (`PROBLEM_STOP` for the
  plugin problems, `AI_STOP` in `TaskRow`, `jobBadge`) and takes the look from there; a hand-drawn mark
  uses the app's `STOP_ICON` / `STOP_TEXT` (`client/src/shared/ui/stateStyles.ts`, complete class names).
  A new stopped place picks a meaning, never a colour.

  | Place | Colour | Why |
  |---|---|---|
  | integrations `connector-stopped`, `auto-not-acknowledged`, `no-connector`, `not-a-business` (`PROBLEM_STOP` `needsAction`, `problemBadge`) and a business's 「〇〇 との行き来は止まっています」 line while its connector is off (`connectionLineTone`) | amber | the admin turns the connector on / confirms the write-back fields |
  | the task row's `not-allowed` 「AI では始められません」 (`TaskRow` `AI_STOP`, `STOP_ICON`) | amber | the member starts it or hands it on |
  | 「会社の設定で止まっています（使いたいときは、管理者に相談してください）」 (`MySwitchesSection`, `data-company-off`; only the switch's words fade) and the server's `WORK_SWITCH_COMPANY_OFF` refusal (a `warning` callout, not `danger`) | amber | an admin can turn it back on |
  | the sync button while automatic sync waits (`syncWaitsForMember`, `TitleBar` `syncWaitsForYou`: icon + mark, name 「…（自動同期は止まっています）」) | amber | the member syncs by hand to resume |
  | `ExternalChangeBanner` 「自動保存は止めています」 (already the warning set) | amber | the member compares and picks a version |
  | 「AI を止めています」 band, Slack / Google / connected services / google-relay operator stop, plugin `stopped` | grey | the operator / an admin stopped it on purpose |
  | plugin `key-stopped` 「選んだ鍵が止められています」 | grey | a key someone stopped on purpose; its page says where to resume (an owner question if it should be amber) |
  | jobs paused by an admin or the responsible person, 「すべて止めています」 | grey | stopped on purpose, known |
  | an own key an admin stopped 「自分の鍵（管理者が止めています）」 | grey | the admin's decision; the member cannot undo it (the line says to ask) |
  | plugin failures, jobs whose person left, the task card's / row's failed AI, the chat's 「止まりました」 | red | a failure (unchanged) |
- **Amber only for warning (a stop the viewer has to act on included) and awaiting**: 「変えています」 (advanced) is `info`; offline results in
  `ApprovalCard` / `MailDraftCard` and 「ブラウザで Google の画面を開きました」 are the info set; error
  messages shown in a warning callout (`{error}` callouts in settings, absences, jobs) are `danger`.
- **New-item mark = one primary dot** `NewDot` (primitives; `bg-unread`, `size-dot`, `role="img"` named
  by its word): the left tabs' dot, the bell's unread dot and its unread rows (were red; since I2 the title bar's
  inbox rows' marks; the ［受け箱］ dot until 2026-11-26), the chat list's
  「新着」 (was a green word, row and folded group), the file tree's new review (was a blinking amber
  dot). The count bubble (`LeftPanelTabs`) is `primary` / `on-primary` since P2d.
- **「閲覧のみ」 replaces 「読むだけ」** in user-facing text: the bell 「起きたこと（閲覧のみ）」 (gone with the bell in I2), google-relay's
  scopes, the integrations' write choice 「書き戻さない（閲覧のみ）」, the relay summary, the agent-events
  description, the browser level's help, second-opinion's 「閲覧のみで聞きます」. Not changed: texts for
  the AI (tool descriptions in `client/electron`), plugin-author errors (`shared/core`), the relay's
  refusal 「ここからは読むだけです」 (server).
- **Admin also**: the owner role badge is `neutral`, the admin role and 個別の設定 `selected`; 「動いています」,
  「使っています」, active grants, 「いま配っている版」, connected 「動いています」 are `success`; picked
  filter toggles (members' department filter, google-relay 「全員」 / names) use `Button variant="selected"`
  (+ `aria-pressed`), no longer primary; the 17 「このページはオーナーと管理者だけが使えます」 /
  「…扱えるのは…」 / 「権限を確認できるのは…」 empty states show `ShieldSlash`, the padlock stays for
  非公開 only. `cn()` (`admin/src/lib/utils.ts`) knows the token scales (type, weight, radius, shadow):
  tailwind-merge read `text-small` as a colour and dropped it beside `text-success-text`.
- **Guarded by** `client/tests/ui/status-colours.spec.ts` (light and dark: every callout tone and badge
  variant against its `--color-*-rgb` tokens on `client/tests/status-ui.html`; the three stopped states
  differ in fill, icon and word; real screens — the task card's failed run, the pending approval card,
  `download-folders-ui?tab=ownkeys&ownkey=stopped`, the title bar's ［受け箱］ (新着 the soft `selected-bg` / `selected-text` count, あなた待ち the soft `danger-bg` / `danger-text` one) and the inbox rows' dots; the amber places —
  `status-ui`'s task rows (`not-allowed` amber, failed red) and title bar (sync waiting),
  `download-folders-ui?tab=mine&company=off|later` (the notice, unfaded; the refusal a warning),
  `editor-tabs-ui?view=external` 「自動保存は止めています」), `autoSyncSchedule.test.ts`
  (`syncWaitsForMember` only with automatic sync on) and
  `admin/tests/status-colours.test.tsx` (the CSS Tailwind 4 generates for every Badge / Callout variant,
  through `tests/token-paint.ts`, shared with `primary-action.test.tsx`; the stopped states apart;
  `cn()` keeping the type size; `jobBadge` by meaning; `problemBadge` / `PROBLEM_STOP` covering every
  problem, the amber badge and line painted in the warning set), `agent-stop.test.tsx` (the band's paused colours
  and who / when). `chat-panel.spec.ts` reads the 新着 dot by its name.
- **Still to move** (later PRs): the app's other hand-made red / amber boxes and texts (`RateLimitMeter`, `DiffViewer`, `ReviewSidePanel`, `MarkdownDiffView`, `BackupHistorySlideOver`,
  `TaskRow`'s CHIP and review mark, `QuickAdd` / `WaitParts` / `TagField` chips (pressable: the chip PR),
  `ChatSidebar`'s 「あなたの番」 heading and amber icons, the
  `ExternalChangeBanner` buttons), the admin's
  hand-written 「管理役」 marks (`text-[10px]`: scope-editor, editor-picker, audience-fields), its
  `ErrorState` and red text lines, `permissions-view`'s 「制限あり」 (`warning`: a decision), the
  explanation boxes without a border (`bg-muted/40`: place-readers, scope-editor), `departments` table
  header.

## Dialog frames, link and selected (P2c, done)

- **One dialog frame per app** (proposal 「ダイアログの枠」): scrim `scrim` (no blur), surface
  `surface-raised`, border `border`, corner `card` (12px), shadow `dialog`, padding `dialog` (20px),
  title `title` (15px, 600), three widths `--size-dialog-sm|md|lg` (400 / 480 / 640). Button row:
  right-aligned, 「やめる」 first (left), the main action last (right).
  - **App** `Dialog` (`client/src/shared/ui/Dialog.tsx`, with `DialogTitle`, `DialogFooter`,
    `DialogCloseButton`): `role` `dialog` / `alertdialog`, `aria-modal`, labelled by its title (or
    `label`); the P1a keys for every dialog — Tab / Shift+Tab wrap inside, Esc closes and stops there,
    focus that strays out comes back, nothing listens for Enter on the document, focus returns to the
    opener, stacked dialogs: only the top one acts (a dialog drawn inside another handles its own
    keys). An ordinary dialog closes on a scrim click (which never takes focus), an `alertdialog`
    and the confirm never do; `dismissible={false}` while something runs (and for the skill wizard,
    whose typing Esc must not throw away; and the first-run 「仕事の道具をつなぐ」, answered only by
    its buttons). Focus starts on `initialFocus`, else on a field that focused itself (`autoFocus`),
    else on the dialog. `padded={false}` for list pickers (their compact header stays; still to move after P3), `size=
    "custom"` for the two wide two-pane ones (`CopySkillModal` 768px, the settings).
    `ConfirmDialog` and `InputDialog` are built on it; moved onto it: `NewFolderDialog`,
    `PrivateFolderHelp`, `TooLargeFileHelp`, `DownloadFoldersSection`'s confirm, `InviteDialog`,
    `BundleActions`, `MakePrivateDialog`, `TaskActions` (both), `WaitParts`, `NewBundleDialog`,
    `BundleChooser`, `BundleField`'s picker, `LinkToTaskDialog`, `PluginSlots`' file action,
    `ConnectToolsScreen` (first run), `NewSkillWizard`, `CopySkillModal`. Tokens only (scrim, z,
    corner, shadow; own surface and keys kept): `SettingsPanel` (on `Dialog` since P2d), the tool viewer (`AppDialogs`),
    `BackupHistorySlideOver` (slide-over), `HandoffControl` (native `<dialog>`). Visible changes:
    titles 14 / 18px → 15px, padding 16 / 24px → 20px, corners 16px → 12px, widths to the nearest
    step, the dark surface zinc-800 / 900 → #202024, one scrim (45% / dark 60%, no blur), Esc and Tab
    now work in the task / record dialogs.
  - **Admin** `DialogContent` (`admin/src/components/ui/dialog.tsx`): the same tokens (`bg-surface-raised
    p-dialog rounded-card shadow-dialog`, overlay `bg-scrim`, title `text-title`, description
    `text-body`) and `size` `sm` / `md` (default) / `lg` instead of each caller's `sm:max-w-*`
    (md / lg → md, xl / 2xl → lg); the sheet's overlay is the scrim. Radix keeps the keys. `cn()`
    knows the token paddings and z-indexes, so a caller's `p-0` replaces `p-dialog`.
- **Accent split by meaning** (owner decision 2026-11-21): text links and text buttons → `link` /
  `link-hover` (dark: the lighter #6cb0ea, was #1264a3 on a dark surface); picked rows, chips,
  options → the `selected` set (`selected-bg`, `-border`, `-text`, `-icon`; the file tree's chosen row
  `selected-bg-hover`, a step stronger, because the tree sits on the grey side panel; its focus ring
  shows on keyboard focus only); focus → `focus-ring` / `focus-border`; spinners, the chat's
  avatar (the member's own bubbles are `surface-sunken` since 2026-11-27, owner FB: quiet like the Claude app), typing dots and cursor, the rate meter's bar, drop outlines and the solid "on"
  toggles (`TaskListPanel` mode and tag, `QuickAdd`'s day) → `primary` (same blue as before; the
  proposal's table gives "on" the primary colour); `ThingIcon` task → `thing-task`. Admin: the indigo
  `brand` → `link` for links (`Button variant="link"` too), `selected-*` for chosen radio cards and
  options, `border-primary` for the chosen folder tab's underline and a radio's dot, `primary` for
  information icons.
- **「AI が用意したもの」 is the AI set** (violet, quiet): the task card's and a step's prepared box
  (`ai-bg` / `ai-border`, Sparkle `ai-icon`), the task row's AI turn (Robot, running spinner), the
  minutes review's and tag suggestions' Sparkle, 「AI が読んでいます…」 and the bundle's AI working
  line. The topic-switch and link-drop questions (not AI-made) are the `info` box.
- **A private place is amber in both apps** (owner decision 2026-11-22, the app is the reference: its
  「あなただけ」 is amber): the admin's 非公開 lock (`subfolder-picker`, `place-picker`, `permissions-view`)
  is `private-text`, and the 「n 人にだけ届きます」 box (`AudienceSummary`) `private-bg` / `private-border`
  (new tokens: amber-50 / amber-200, dark the amber `d` steps; pair `private-text` on `private-bg`). Was
  the indigo `brand`.
- **Owner decisions 2026-11-22 on P2c**: the list's 「番ごと／案件ごと」 and the chosen tag stay the solid
  `primary` (not the proposal's raised segment); the skill wizard does not close on Esc or the scrim.
- **Guarded by** `client/tests/ui/dialog-frame.spec.ts` (light and dark: the confirm, name, new folder,
  waiting and invite dialogs against the scrim / surface / corner / shadow / 15px title tokens and the
  button order; Tab wrap, Esc, focus return on a moved dialog; the scrim closes an ordinary dialog,
  not a confirm; the tree's chosen row, the task card's links and its AI box against `selected` /
  `link` / `ai`; dark links #6cb0ea) and `admin/tests/dialog-frame.test.tsx` (the generated CSS of
  `DialogContent` and the confirm: surface, scrim, 12px, shadow, 20px, 15px title, the three widths,
  the button order; a link button and a chosen radio card; the private box and lock in amber). Each fails when its guard is reverted
  (checked by mutation).
- **Left after P2c** (all moved in P2d, below): the admin's activity chart bar and
  `permissions-view`'s 「制限あり」 (P2b list) remain; `--brand` stays `keep` until they move.

## The deferred spots and the last white screens (P2d, done)

- **On the shared `Dialog`** (frame, scrim, keys): `TidiedTabsDialog` (「片づけたタブ」, `size="lg"`, list
  picker without padding; was its own `z-50` box with a 20 % scrim and its own Esc listener), the
  settings (`SettingsPanel`, `size="custom"`, `max-w-[1040px]`; its own window Esc listener and backdrop
  click are gone: Tab now stays inside, focus goes back to the opener; the surface is
  `surface-raised` — dark #202024, was zinc-900 —, the nav `bg`, lines `border`; the nav's indigo stays
  for the switch / checkbox PR), `SyncPreviewDialog` (`md`, was 512px; its undo confirm and the
  before / after open on top of it and take Esc first) and `DiffModal` (`DiffViewer.tsx`, wide
  `custom`; was `z-[60]` over a 60 % scrim). When 「片づけたタブ」 closes and what opened it is gone
  (the tidy notice's button, a menu item), focus goes to the open tab in the editor's tab bar
  (owner decision 2026-11-22; the active tab is focusable by script, `tabIndex=-1`, with the
  focus ring). `TidiedTabsDialog` and the settings no longer
  listen for Esc on the document / window: an Esc a field inside handles (the voice shortcut
  recorder) stops there.
- **⌘K's palette (`FindPalette`) is drawn like a menu** over a light veil (owner decision
  2026-11-22): the token `scrim-palette` (light 20 %, dark 40 %; lighter than the dialog `scrim`
  45 % / 60 %; a click on it closes the palette), `z-menu`, `surface-raised`, `border`, corner `card`,
  `shadow-pop`; rows `selected-bg` / `surface-sunken`. A new menu-like panel that needs a veil uses
  `scrim-palette`, a dialog `scrim`.
- **Theme-following now** (were white in dark): `ChatAuthSettings` (the chat's settings) — page
  `var(--color-surface)`, lines `border`, option cards `bg` with `border` (the chosen one the
  `selected` set, its icon tile `primary` / `on-primary`, its check `selected-icon`; `aria-pressed`),
  the key input `bg` / `border-control` / `focus-border`, 「接続を再確認」 `link`, errors `danger-text`,
  key notices `warning-text`, no glow shadow; its `ClaudeSignInCard` (the warning box
  `STATE_BOX.warn`, texts `text` / `text-muted` / `warning-text`; it also shows in `ChatAuthGate`,
  where its text was dark on dark); the voice shortcut box inside now reads in dark (it followed the
  theme already, on a white page). `SyncPreviewDialog`: the semantic surfaces and texts; a change's
  mark by meaning (`CHANGE_MARK`): added `success-text`, deleted `danger-text`, changed `info-text`
  (grey: was amber, which is for warnings). `DiffViewer`: a removed line `danger-bg` /
  `danger-text`, an added one `success-bg` / `success-text` (each pair AA in both themes, `PAIRS`),
  the two side headers the same sets, padding rows `bg`, unchanged lines `text-muted`, line
  numbers `text-subtle`.
- **Primary by meaning**: `LeftPanelTabs`' count bubble `bg-primary text-on-primary` and the chosen
  tab's underline `border-primary`; `ResizeHandle`'s line while dragged `bg-primary`; `ChatSidebar`'s
  「表示中」 `selected-text`. Then `accent` left `client/tailwind.config.js` (with the unused `glow`
  colours); preview pages use `bg-primary` / `text-link`.
- **What changed in light mode**: the diff's red / green text is darker (red-700 / emerald-700 on
  red-50 / emerald-50; was red-400 / green-400, under 3:1) and its panes white (were #f8f8f8); the
  sync preview's 「変更」 is grey (owner: OK), its surface white (was #f8f8f8), title 15px, padding 20px, width
  480px; the palette's veil is the same 20 % as before (dark 40 %); 「片づけたタブ」 centred (was near the top),
  640px (was 576px), title 15px; the chat settings' option cards show a thin line and the key field's
  corner is 8px (was 12px); the settings' nav #fafafa (was zinc-50 at 80 %). Dark: every one of
  them follows the theme.
- **Guarded by** `client/tests/ui/dialog-frame.spec.ts` (light and dark: 「片づけたタブ」, the settings,
  the sync preview and the before / after against the frame tokens; the palette's veil
  `scrim-palette` (present, lighter than `scrim`) on `z-menu` with `surface-raised` / `shadow-pop`;
  Tab stays inside and Esc closes 「片づけたタブ」 (focus then on the open tab, by Esc and by ×) and
  the settings, focus back to the settings' opener — `download-folders-ui?closed=1`; Esc closes the
  before / after first, then the preview), `dark-readability.spec.ts` (the chat settings —
  `sign-in-ui?screen=chat-settings&mode=…&claude=…` — with the chosen option `selected-bg`, the sync
  preview, the before / after: removed and added lines readable on their fills and different,
  painted from the danger / success sets — `keep-work-ui?view=diff`), `status-colours.spec.ts` (the
  count bubble, the chosen tab's underline and a dragged divider in `primary`, on `status-ui`) and
  `design-tokens-bridge.test.ts` (no `accent` colour). Each was checked to fail with its change
  reverted.

## Sizes, type and corners (P3, done)

- **Type steps by moving the screens, not the names**: every exact or half-pixel arbitrary size in the
  app moved to its step — `text-[11px]` / `[10.5px]` → `text-caption`, `[12px]` / `[11.5px]` / `[12.5px]` →
  `text-small`, `[13px]` / `[13.5px]` → `text-body`, `[15px]` → `title`, `[17px]` → `heading` (the admin's
  `[11px]` / `[12px]` too). A step carries its line height and weight, so the weight the text had is kept
  where it differs: `text-caption font-normal` (about 180 of the 11px texts were regular; the step is 500),
  `!text-caption !font-normal` under an important size. Visible: half pixels round (11.5 / 12.5 → 12,
  10.5 → 11, 13.5 → 13) and lines take the step's height (±1–2px per line). Not moved yet (each a
  visible size change): `text-[10px]` / `[9px]` (→ 11), `[14px]` / `[14.5px]` / `[22px]`, and Tailwind's
  `text-xs` / `text-sm` / `text-lg` in both apps (their fixed line heights differ from the steps').
- **Radius steps**: the exact ones moved in both apps — `rounded` / `rounded-[4px]` (app) and
  `rounded-sm` (admin, 4px there) → `rounded-small`, `rounded-lg` → `rounded-control`, `rounded-xl` →
  `rounded-card` (sides included); no corner changed. Left: `rounded-md` (6px: no step — 4 or 8 is the
  owner's call per place), `rounded-2xl` (16px), the app's `rounded-sm` (2px).
- **Buttons**: `BUTTON_SIZE` (`client/src/shared/ui/buttonStyles.ts`) — `md` `h-control px-control-x
  text-body` (32px, 12px sides, 13px; was 14px sides), `sm` `h-control-sm px-control-sm-x text-small`
  (28px). The app `Button`'s `secondary` is `surface` / `border-control` / `text`, hover `surface-sunken`;
  `ghost` `text-muted`, hover `surface-sunken` / `text`.
- **Dialog buttons are the `Button`** (proposal: 「やめる」 secondary, the main action primary, both 32px):
  `ConfirmDialog` (its 「やめる」 was a borderless text button, its main action 600 weight: now
  secondary and 500), `InputDialog` (was 36px / 14px / 6px corners; its field 8px), and the task / record
  dialogs that used `SMALL_BUTTON` + `MAIN_BUTTON` (a 20px chip beside a 30px button): `WaitParts`,
  `TaskActions` (both), `NewBundleDialog`, `MakePrivateDialog`, `BundleActions`, `InviteDialog`.
  `SMALL_BUTTON` / `MAIN_BUTTON` stay for buttons inside cards and rows.
- **One switch per app**: the app's `Switch` (`primitives.tsx`; `disabled`, `className` for its place)
  and the admin's new `Switch` (`admin/src/components/ui/switch.tsx`): `--size-switch-w|h` 36×20, on
  `primary`, off `border-strong` (3:1; was zinc-300 / white 20 %), thumb `on-primary` with `shadow-card`,
  the `focus-ring`, disabled `opacity-disabled`. Moved onto it: `MySwitchesSection`'s copy (was 44×24
  indigo), the admin's `features-page` and `task-settings-page` copies (were 44×24, off `input`).
- **Check boxes**: `TriCheckbox` — `--size-checkbox`, corner `small`, on `primary` / `on-primary`, off
  `border-strong` on `surface`, disabled the `disabled` set (was indigo). Native check boxes and radio
  buttons take `accent-color: var(--color-primary)` from the base layer of `client/src/index.css` and
  `admin/src/app/globals.css` (were the browser's blue, indigo or a literal `#1264a3`); a class still wins.
- **The settings' left list** (`SettingsPanel` nav): the chosen item `surface-raised` + `shadow-card` +
  a `border` ring, its icon `selected-icon` (was indigo), others `text-muted` / icon `text-subtle`, hover
  `surface-sunken`, height `control`, the `focus-ring`; group names `caption` `text-subtle` (was zinc-400,
  under AA), the title `title`, the company name `small` `text-subtle`. The download-size bar
  (`UsageBar`, `IndeterminateBar`) and its legend are `primary` (was indigo), a planned growth
  `selected-border`; 「ダウンロードする」 marks `selected-bg` / `selected-text`.
- **How it was checked**: before / after screenshots of every preview page and query the UI specs open
  (200 × light / dark), and the computed font size, weight and colour of every text element compared
  between the two builds: no weight changed except the confirm's two buttons; sizes changed only by
  the half pixels above.
- **Guarded by** `client/tests/ui/sizes-type-corners.spec.ts` (light and dark: the Button's two sizes and
  secondary colours, the confirm's / name dialog's / new folder dialog's buttons, the switches' size and
  colours in 「AI に任せること」 and 自動同期, the tri-state and native check boxes, the settings' left list —
  each against what its token resolves to on the page) and `admin/tests/switch-and-corners.test.tsx`
  (the generated CSS of the admin `Switch`, the native check box rule). Each fails with its change
  reverted (checked by mutation).
- **Still to move** (later PRs): the list pickers' compact headers (`padded={false}`), `SMALL_BUTTON` /
  `MAIN_BUTTON` in cards and rows, the settings' fields (`INPUT` / `SELECT` / `TEXTAREA` in
  `SettingsPanel`, `AutoSyncSettings`, `OwnKeysSection`, `AgentEnvSettings`, `AbsenceSection`,
  `TodayFolderSetting`, `VoicePromptSettings`: indigo focus), the other indigo (`NewFolderDialog`,
  `FileTreeHeader`, `TidyNoticeBar`, `DepartmentBar`, `EditorTabBar`, `TabGroupParts`, `OwnKeysSection`'s
  focused row, the settings' section icons), the admin's hand-made check boxes (`member-checklist`,
  `groups-page`, `department-members-dialog`, `place-readers-dialog`), and in `features/inbox` and
  `features/browser-plans` (another PR's area) 8 bare `rounded`.

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
