# P26b panel design brief - the ONE design authority for every UI unit

Read this before touching `packages/design-tokens`, `packages/ui` or `app/frontend`. Every unit dispatch
in P26b points here instead of restating the rules. Canon: ADR 0007 (Base UI headless primitives +
Tailwind v4, one signature accent, OKLCH tokens, no themed component library), ADR 0012 (borrow patterns
from the references, never code or copy strings), ADR 0015 (pacing default on), ADR 0016 (no capacity
figures in tenant surfaces). Look-and-feel target: OpenPanel (`D:\kd\openpanel-main`) - a dense, quiet,
neutral SaaS console with one accent; instance-card and QR-connect patterns from `demo/evolution-manager-v2`
and `demo/Blastup` (patterns only).

## 1. Stack facts (verified 2026-09-07)

- React 19.2, TanStack Router 1.170 (file routes in `app/frontend/src/routes/**`, `autoCodeSplitting`),
  TanStack Query 5, react-hook-form 7 + zod 4, Tailwind 4.3 (`@tailwindcss/vite`), Vitest 4 + Testing
  Library + `@testing-library/user-event` + axe-core (jsdom), Playwright 1.56 (`app/frontend/tests/e2e`).
- Primitives library: **`@base-ui/react` 1.7.0** (NOT Radix - ADR 0007). Import per component:
  `import { Dialog } from '@base-ui/react/dialog'` (namespace exports: `Dialog`, `AlertDialog`, `Drawer`,
  `Popover`, `Tooltip`, `Menu`, `Select`, `Combobox`, `Autocomplete`, `Tabs`, `Checkbox`, `Switch`,
  `Progress`, `Avatar`, `Toast`, `OTPField` (from `@base-ui/react/otp-field`), `Field`, `NumberField`,
  `ScrollArea`, `Collapsible`, `Accordion`; named exports: `RadioGroup`, `Radio`, `Form`, `Separator`).
  **Verify every API against the installed type files** (`node_modules/@base-ui/react/<component>/index.d.ts`
  from `packages/ui`) - never from memory. Base UI popups expose `data-open`, `data-starting-style`,
  `data-ending-style`, `data-side`, `data-highlighted`, `data-checked`, `data-disabled`, `data-invalid`
  attributes; animate them with Tailwind `data-[starting-style]:opacity-0` + `transition` classes.
- Icons: `lucide-react` (installed in `@wp/ui` and `app/frontend`). Size 16 px inside controls, 20 px in
  nav, 40-48 px in empty states. Always `aria-hidden` unless the icon is the only label (then `aria-label`).
- Tables: `@tanstack/react-table` v8 (installed in `@wp/ui`). Class joiner: `cx()` from `packages/ui/src/lib/cx.ts`.
- Fonts: Instrument Sans + Noto Sans Devanagari are loaded by `app/frontend/index.html`; mono = Geist Mono
  fallback stack. Hindi must render - never pick a font stack without a Devanagari fallback.

## 2. Tokens (`packages/design-tokens/src/tokens/*.tokens.json` -> `pnpm tokens:build`)

Colour lives ONLY here (guard `check:no-raw-hex` fails on any `#hex`, `rgb(`, `hsl(` or `oklch(` in
`packages/ui/src`, `app/*/src`, `admin/*/src`, `website/src`). Every role below is a
`color.semantic.light.<role>` + `color.semantic.dark.<role>` pair, which the build maps to `--color-<role>`
so Tailwind classes `bg-<role>`, `text-<role>`, `border-<role>`, `ring-<role>` exist. Opacity via Tailwind
modifiers (`bg-fg/40`) is fine.

| Role                                      | Purpose                                                              | Light (OKLCH)                                                                      | Dark (OKLCH)                                     |
| ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| `bg`                                      | app canvas                                                           | `0.985 0.002 250`                                                                  | `0.13 0.006 250`                                 |
| `surface`                                 | cards, popovers, inputs, top bar                                     | `1 0 0`                                                                            | `0.17 0.006 250`                                 |
| `surface-2`                               | muted surface: table heads, hover rows, code, sidebar rail           | `0.965 0.004 250`                                                                  | `0.21 0.006 250`                                 |
| `surface-3`                               | pressed/selected surface                                             | `0.94 0.005 250`                                                                   | `0.25 0.006 250`                                 |
| `fg`                                      | primary text                                                         | `0.17 0.01 255`                                                                    | `0.97 0.003 250`                                 |
| `muted`                                   | secondary text                                                       | `0.50 0.015 255`                                                                   | `0.70 0.01 250`                                  |
| `subtle`                                  | tertiary text, placeholder, disabled icons                           | `0.66 0.012 255`                                                                   | `0.52 0.01 250`                                  |
| `border`                                  | hairlines                                                            | `0.92 0.006 250`                                                                   | `0.27 0.006 250`                                 |
| `border-strong`                           | input borders, dividers that must read                               | `0.86 0.008 250`                                                                   | `0.34 0.007 250`                                 |
| `ring`                                    | focus ring                                                           | `0.62 0.14 150 `                                                                   | `0.72 0.15 150`                                  |
| `accent`                                  | the ONE brand accent (WP green) - primary buttons, active nav, links | `0.55 0.15 150`                                                                    | `0.72 0.16 150`                                  |
| `accent-hover`                            | hover of accent                                                      | `0.49 0.15 150`                                                                    | `0.78 0.15 150`                                  |
| `accent-fg`                               | text on accent                                                       | `0.99 0.01 150`                                                                    | `0.15 0.03 150`                                  |
| `accent-soft`                             | accent tint bg (badges, active nav bg, selected row)                 | `0.95 0.04 150`                                                                    | `0.25 0.05 150`                                  |
| `success` / `success-soft`                | ok states                                                            | `0.55 0.15 150` / `0.95 0.04 150`                                                  | `0.75 0.16 150` / `0.26 0.05 150`                |
| `warning` / `warning-soft`                | attention                                                            | `0.68 0.16 70` / `0.96 0.05 80`                                                    | `0.82 0.16 80` / `0.30 0.06 75`                  |
| `danger` / `danger-hover` / `danger-soft` | destructive                                                          | `0.55 0.21 25` / `0.49 0.21 25` / `0.95 0.03 20`                                   | `0.70 0.19 22` / `0.76 0.18 22` / `0.28 0.07 22` |
| `info` / `info-soft`                      | neutral notices                                                      | `0.55 0.15 250` / `0.95 0.03 250`                                                  | `0.74 0.13 250` / `0.27 0.06 250`                |
| `sidebar`                                 | sidebar bg                                                           | `0.975 0.003 250`                                                                  | `0.15 0.006 250`                                 |
| `sidebar-fg` / `sidebar-muted`            | sidebar text / secondary                                             | `0.25 0.01 255` / `0.50 0.015 255`                                                 | `0.93 0.004 250` / `0.68 0.01 250`               |
| `sidebar-border`                          | sidebar hairline                                                     | `0.91 0.006 250`                                                                   | `0.24 0.006 250`                                 |
| `sidebar-active` / `sidebar-active-fg`    | active nav item bg / text                                            | `0.93 0.04 150` / `0.35 0.12 150`                                                  | `0.26 0.05 150` / `0.85 0.12 150`                |
| `overlay`                                 | dialog backdrop                                                      | `0.15 0.01 250 / 0.55`                                                             | `0.05 0 0 / 0.7`                                 |
| `chart-1..5`                              | data series                                                          | `0.55 0.15 150`, `0.60 0.14 250`, `0.70 0.15 70`, `0.60 0.18 320`, `0.65 0.12 200` | lighten each by +0.12 L                          |

Existing role names (`bg surface fg muted border accent accent-fg success warning danger info`) keep
their meaning so current classes keep compiling; `accent.value/hover/fg` and `neutral.*` primitives stay.
Neutrals: re-derive the `neutral` scale on hue 250 with the L values above.

Other scales (all through `@theme` so utilities exist): radius `sm 0.375rem`, `md 0.5rem` (controls),
`lg 0.75rem` (cards), `xl 1rem` (dialogs), `full`; spacing scale unchanged; shadows `sm` `0 1px 2px
oklch(0 0 0/0.05)`, `md` `0 4px 12px oklch(0 0 0/0.08)`, `lg` `0 16px 40px oklch(0 0 0/0.14)`, `card`
`0 1px 2px oklch(0 0 0/0.04), 0 0 0 1px oklch(0 0 0/0.03)`; motion durations fast 120 ms / normal 180 ms /
slow 300 ms and easings standard / decelerate / accelerate emitted as `--ease-*`; type scale emitted as
`--text-*` with paired `--text-*--line-height`: xs 12/16, sm 13/20, base 14/20, lg 16/24, xl 18/26,
2xl 22/28, 3xl 28/34, 4xl 34/40 (px). Weights 400/500/600/700. `build.mjs` must emit every one of these
into `css/tailwind-theme.css`, and `tokens-build.test.ts` must assert the new roles + scales exist.
Add `@keyframes` for `fade-in`, `fade-out`, `scale-in`, `slide-in-from-right`, `slide-in-from-bottom`,
`shimmer` under `--animate-*` in the generated theme (durations reference the motion tokens).

## 3. Layout system (app shell)

- Desktop (`lg` = 1024 px and up): fixed left sidebar `w-64` (256 px), collapsible to a `w-16` icon rail
  (toggle persisted in `localStorage['wp.sidebar']`, try/catch); top bar `h-14` (56 px) sticky, `bg-surface/80
backdrop-blur border-b border-border`; content area `mx-auto w-full max-w-[1400px] px-6 py-6`.
- Mobile (< 1024 px): no sidebar; hamburger in the top bar opens the navigation in a left `Sheet`
  (Base UI Dialog/Drawer) with the same nav; top bar keeps brand + bell + user menu; page header actions
  wrap; every grid collapses to one column at 390 px; tables scroll horizontally inside their own
  `overflow-x-auto` container or switch to stacked cards - the body never scrolls horizontally.
- Sidebar anatomy: brand block `h-14` (logo mark + `app.name` + workspace name, truncated), nav groups
  with `text-[11px] uppercase tracking-wide text-sidebar-muted` group labels (Overview / Messaging /
  Audience / Settings), items `h-9 rounded-md px-3 gap-3 text-sm` with a 20 px lucide icon, active =
  `bg-sidebar-active text-sidebar-active-fg font-medium`, hover = `bg-surface-2`; footer = realtime chip
  (live / reconnecting / offline: text + tone, never colour alone), theme toggle, collapse toggle.
- Top bar anatomy: left = hamburger (mobile) + breadcrumbs; centre = command palette trigger (a search-
  shaped button with a `Ctrl K` kbd hint, `lg` only); right = instance switcher (only when at least one
  instance exists), notification bell, locale switch (en / hi), user menu (avatar initials -> name, email,
  workspace, role, Log out).
- Page header (`PageHeader` in `app/frontend/src/components/page-header.tsx`): optional breadcrumbs
  (`text-xs text-muted`), `h1 text-2xl font-semibold tracking-tight`, one-line description `text-sm
text-muted`, right-aligned actions (primary button first), optional tabs row below. Every route renders
  exactly one `PageHeader`.
- Density: table rows `h-11`, inputs and buttons `h-9` (`sm` `h-8`, `lg` `h-10`), card padding `p-5`,
  section gaps `gap-6`, KPI grid `grid gap-4 sm:grid-cols-2 xl:grid-cols-4`.

## 4. Primitive inventory and API conventions (`packages/ui`)

One file per primitive in `packages/ui/src/<kebab>.tsx` (< 300 lines, split helpers into
`<kebab>-parts.tsx` when needed), exported from `packages/ui/src/index.ts`, tested in
`packages/ui/test/<kebab>.test.tsx` (first line `// @vitest-environment jsdom`, Testing Library +
user-event + an axe run with the `AXE_OPTIONS` from `test/a11y.test.tsx`). Also add one fixture per new
primitive to `test/a11y.test.tsx`'s `useFixtures()` and one card per primitive to the gallery
(`packages/ui/examples/<kebab>.example.tsx`, aggregated by `packages/ui/examples/index.tsx` and mounted at the
dev-only route `/_dev/gallery` in `app/frontend`, which renders `notFound` when `!import.meta.env.DEV`).

Conventions every primitive obeys:

- `'use client'` first statement when the file uses hooks or DOM event props (guard
  `check:ui-client-directive`); purely presentational files carry none.
- No copy inside `@wp/ui`: every visible string (close label, loading label, empty title, page-size label)
  arrives via props. `data-testid`, `className`, `id` and `...rest` pass through to the root element.
- `React.forwardRef` on anything that can be a form control or receive focus programmatically.
- Variants: `variant` and `size` string unions with a `Record<..., string>` class map; `tone` unions
  `neutral | success | warning | danger | info | accent` for badges/alerts/toasts.
- Focus: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
ring-offset-bg`; disabled: `disabled:opacity-50 disabled:pointer-events-none`; motion: `transition-colors
duration-150`; popups: `data-[starting-style]:opacity-0 data-[starting-style]:scale-95
data-[ending-style]:opacity-0 transition-[opacity,transform] duration-150`.
- Colour-only signalling is forbidden: every status badge/dot ships text (or `aria-label`).

Inventory (owner unit in brackets):

- [U1b] `button` (variants `primary | secondary | outline | ghost | danger | link`, sizes `sm | md | lg |
icon`, `loading`, `leadingIcon`/`trailingIcon`), `icon-button`, `input` (label, description, error,
  `leadingIcon`, `trailingAddon`, `aria-invalid`), `textarea` (auto-grow optional, `maxLength` counter),
  `password-input` (show/hide toggle with label prop), `select` (Base UI Select: label, placeholder,
  options `{value,label,description?,disabled?}`, error), `checkbox`, `switch`, `radio-group`, `label`,
  `form-field` (react-hook-form `Controller` wrapper: label + control + description + zod error, sets
  `aria-invalid`/`aria-describedby`), `badge` (tones + `dot`), `status-dot`, `avatar` (image, initials
  fallback, sizes), `card` (+ `CardHeader/Title/Description/Body/Footer`, `interactive` hover lift),
  `kpi-stat` (label, value, delta with direction + text, icon, `loading` skeleton), `skeleton` (+
  `SkeletonText`, `SkeletonRows`), `empty-state` (icon, title, body, primary + secondary action, `compact`),
  `error-state` (title, body, retry action, optional details `<code>`), `spinner`, `tooltip` (Base UI),
  `separator`, `kbd`, `alert` (inline banner with tone + icon + title + body + action).
- [U1c] `dialog` (Base UI Dialog: sizes sm/md/lg, header/body/footer slots, close label prop, focus trap
  proven by test), `alert-dialog` (confirm pattern: title, body, confirm/cancel labels, `destructive`),
  `sheet` (keep the existing API; add `side: left | right | bottom`, sizes, header/footer slots),
  `dropdown-menu` (Base UI Menu: items with icon, shortcut, destructive tone, separators, submenus not
  needed), `popover`, `tabs` (Base UI Tabs; `variant: underline | pill`), `data-table` (TanStack Table v8:
  typed `columns`, `data`, `isLoading` -> skeleton rows equal to `pageSize`, `emptyState` node,
  `errorState` node, client sorting via header click with `aria-sort`, `enableRowSelection` optional,
  `onRowClick`, `columnPriority` (`hidden md:table-cell` / `lg:table-cell`), sticky header, `caption` prop
  required, toolbar slot, footer with either client pagination (`page`, `pageSize`, labels via props) or
  keyset `loadMore` (`hasMore`, `onLoadMore`, `isLoadingMore`)), `pagination`, `toast` (KEEP the existing
  `ToastProvider`/`useToast` API - restyle: bottom-right stack, tone icon, title/description, dismiss button
  (label prop), enter/exit animation, max 4 visible, `duration` respected; the injectable timer stays),
  `progress` (Base UI Progress, label + value text), `stepper` (horizontal on desktop / vertical on
  mobile; states done/current/upcoming with icons and numbers; `aria-current="step"`), `otp-input` (Base
  UI OTPField, 6 cells, paste support, `error`), `phone-input` (country code select with a small ISO list
  prop + national number input, emits E.164 string; validation stays in the caller's zod schema),
  `qr-display` (renders a data URL or SVG string inside a framed white tile with countdown ring slot +
  expired overlay slot; presentational), `date-time-picker` (native `<input type="datetime-local">`
  wrapped with label/error/min; timezone label prop - no calendar library), `command-palette` (Base UI
  Dialog + a filtered list: `items {id, label, group, icon?, keywords?, onSelect}`, arrow-key navigation,
  `Enter` runs, `Escape` closes, `Ctrl/Cmd+K` open handled by the caller), `scroll-area`, `collapsible`.
- [U1a] tokens + `build.mjs` + `tokens-build.test.ts` + regenerated `css/*.css` + `tokens.generated.ts`.

## 5. Route-level requirements (`app/frontend`)

Keep every `features/<area>/api.ts`, `keys.ts`, hook and the `@wp/contracts` bindings; replace only the
presentation. Every route: one `PageHeader`; loading = skeletons shaped like the final layout (no spinner-
only pages, no layout shift); empty = `EmptyState` with a real next action; error = `ErrorState` with retry
(`refetch`); every mutation = toast (success + failure) and `loading` on its button; destructive actions =
`AlertDialog`; forms = `FormField` + zod inline messages, `aria-invalid`, disabled submit while pending;
optimistic updates only where the API is idempotent (mark-read, pause/resume, toggle); dark mode parity;
390 px layout; both locales (`en`, `hi`) - **every new string is an `@wp/i18n` key added to BOTH `en*.ts`
and `hi*.ts` catalogues** (`catalogue-parity.test.ts` fails otherwise); use the existing `@wp/domain` copy
constants (`ONBOARDING_COPY`, `INSTANCE_CARD_COPY`, `SAFE_MODE_DISCLAIMER`, `BROADCAST_DISCLOSURE`,
`GROUP_RISK_DISCLOSURE`, ...) exactly where they are used today.

**Preserve every existing `data-testid`** - 23 unit test files and the e2e specs depend on them. New
test ids follow `<area>-<thing>` kebab-case. When a screen is restructured, the old test id moves to the
element that plays the same role.

Copy guards (`check:copy`): in `app/frontend/**` and `packages/ui/**` never write the capitalised
fan-out feature name, the capitalised community-chat feature name (singular or plural) or the two-word
pacing feature name in code, comments or JSX - reference them via i18n keys or the domain constants
(`BROADCAST_DISCLOSURE`, `GROUP_RISK_DISCLOSURE`, `SAFE_MODE_DISCLAIMER`); never write any phrase listed in
`packages/domain/src/copy/banned-claims.ts`. `check:capacity-gate`: no capacity figure
(sessions per box, MB per session, sends per day, latency numbers) anywhere in `app/frontend/**`.

Onboarding gate (decided this phase, 2026-09-07): the dashboard `/` is reachable once
`onboardingStep` is `connect_whatsapp` or later (the backend's own entitlement threshold, R-56); earlier
steps redirect to `/onboarding`. The dashboard shows a "Getting started" checklist card until a number is
linked and a first message is sent. The backend never advances `send_test`/`done` today - that is a carried
open item, not something the UI fakes.

## 6. Mechanical conventions (from `.claude/rules/core-invariants.md`)

- Format: `pnpm exec prettier --config packages/config/prettier.config.mjs --write <files>`; lint: `pnpm exec
eslint --config packages/config/eslint.config.js <files>`. Never the bare binaries. Run both on every file
  you touched BEFORE reporting green; `max-lines: 300` is an error and comments count.
- Unit tests: `pnpm exec vitest run <path>` from the repo root (root `vitest.config.ts` owns
  `packages/*/test/**/*.test.tsx` and `app/*/src/**/*.test.tsx`). Narrowest run first.
- Guards you must run before reporting: `pnpm run check:no-raw-hex`, `pnpm run check:ui-client-directive`,
  `pnpm run check:copy`, `pnpm run check:capacity-gate`, and `pnpm -F app-frontend exec tsc -b` (or
  `pnpm run typecheck` when you touched packages).
- PowerShell users: never pipe a native command's stderr; redirect all streams to a file and read the tail.
