# Panel UI refresh spec (2026-09-08) - the ONE authority for this refresh

Founder feedback after the P26b review: the panel is clean but reads as a generic template - flat KPI tiles
without cards, no data visualisation, native browser `<select>` controls, a plain auth screen, a plain
onboarding card, and no motion anywhere. Target: a production SaaS panel that feels hand-designed (the
founder's two reference dashboards: a left sidebar with grouped nav and a soft active pill, a top bar with a
centred search, KPI cards with an icon tile + large number + a hint line, real charts - horizontal bar lists,
donut rings, radial gauges - card headers with a title and a small right-side control, generous whitespace,
rounded-xl surfaces, soft borders, one accent colour used sparingly, subtle enter animations).

This spec EXTENDS `docs/design/P26b-design-brief.md`. Where the two disagree, this file wins. Everything
here is honest UI: every number and bar is derived from a real API response that already exists; no
synthetic time series, no invented deltas, no "compared to last month" without data to compare.

## 0. Hard rules (paste into every unit)

1. Do NOT touch any file the concurrent admin session owns: `admin/**`, `app/backend/**`,
   `packages/contracts/**`, `packages/domain/**`, `packages/i18n/src/catalogues/en-shell.ts`,
   `packages/i18n/src/catalogues/hi-shell.ts`, `app/frontend/src/features/auth/**`,
   `app/frontend/src/routes/_authed.tsx`, `app/frontend/src/routes/{login,signup,totp,verify-email,
forgot-password,reset-password,impersonate}.tsx`, `app/frontend/src/lib/**`,
   `app/frontend/src/components/impersonation-banner.tsx`, `app/frontend/package.json`, any lockfile,
   `db/**`, `scripts/**`. Never restart or stop any dev process. Never run the full gate.
2. New copy goes ONLY in the unit's own pre-wired catalogue pair (`packages/i18n/src/catalogues/
en-<unit>.ts` + `hi-<unit>.ts`, same key set - `catalogue-parity.test.ts` enforces it). `@wp/ui` carries
   no copy: every string is a prop.
3. No raw colours anywhere outside `packages/design-tokens` (`check:no-raw-hex` bans `#hex`, `rgb(`,
   `hsl(`, `oklch(`). Gradients use `var(--color-*)` tokens or Tailwind opacity modifiers (`bg-accent/10`).
   SVG charts colour via Tailwind `stroke-*` / `fill-*` classes or `currentColor` only.
4. `max-lines: 300` is an ESLint ERROR. Split siblings early (`*-parts.tsx`, `*-support.ts`).
5. Every animation has a `motion-reduce:` fallback (`motion-reduce:animate-none`,
   `motion-reduce:transition-none`). Nothing animates forever except the live-dot pulse and the auth aurora,
   both `motion-reduce:animate-none`. Enter animations run once on mount; keyed re-mounts are deliberate.
6. Interactive files in `packages/ui/src/**/*.tsx` start with `'use client';`
   (`check:ui-client-directive`). Purely presentational files do not.
7. Format + lint ONLY via `pnpm exec prettier --config packages/config/prettier.config.mjs --write <files>`
   and `pnpm exec eslint --config packages/config/eslint.config.js <files>`. Run both on every file you
   touched BEFORE reporting green.
8. Tests are evidence: TDD (adjust or add the test first), `// @vitest-environment jsdom` for React tests,
   run the narrowest file(s) with `pnpm exec vitest run <path>` from the repo root, and paste the verbatim
   tail. Keep every existing `data-testid` that a test or `app/frontend/tests/e2e/**` references.
9. No new dependencies. Charts are hand-written SVG in `packages/ui`.
10. Honest copy: never write the capitalised singular fan-out feature word, the capitalised community-chat
    feature word, or the two-word pacing feature name in a new file (the `check:copy` guard requires a
    disclosure constant in any file that does). Say "the pacing profile", "fan-out", "chats" instead. No
    delivery-speed claims, no restriction-avoidance promises, no capacity figures in `app/frontend/**`.
11. Dark mode and 390 px must both work for every changed surface (tokens already carry the dark palette;
    grids collapse to one column below `sm`).

## 1. Visual language

- Surfaces: page `bg-bg`; cards `rounded-xl border border-border bg-surface shadow-card` (Card default
  radius moves from `lg` to `xl`); nested tiles `rounded-lg bg-surface-2`; section gap `gap-6`; card padding
  `p-5` (`p-6` for hero cards).
- Type scale: page title `text-2xl font-semibold tracking-tight`; card title `text-base font-semibold`;
  KPI value `text-3xl font-semibold tracking-tight tabular-nums`; labels `text-sm text-muted`;
  meta `text-xs text-muted`; eyebrow `text-[11px] font-medium uppercase tracking-wider text-muted`.
- Icon tiles: `flex h-9 w-9 items-center justify-center rounded-lg` with a tone pair
  (`bg-accent-soft text-accent`, `bg-info/10 text-info`, `bg-success/10 text-success`,
  `bg-warning/10 text-warning`, `bg-danger/10 text-danger`). Icons 16-18 px, `strokeWidth={1.75}`.
- One accent (the existing green). Charts use accent + success/info/warning/danger tones only, never a
  rainbow. Track colour `stroke-surface-2` / `bg-surface-2`.
- Controls: no native `<select>` anywhere in the shell. Menus use `DropdownMenu`; pickers use `Select`.
- Hover: cards that navigate lift `hover:-translate-y-0.5 hover:shadow-md`; nav items `hover:bg-surface-2`
  plus `hover:translate-x-0.5`; buttons keep `active:translate-y-px`; primary button gains
  `shadow-sm hover:shadow-md`.

## 2. Tokens and motion (`packages/design-tokens`) - unit F1

Add to `motion.tokens.json`: `duration.slower = 600ms`, `duration.pulse = 1800ms`, `duration.drift = 6s`,
`duration.glacial = 12s`. Extend `build.mjs` so each `ANIMATION_SPECS` row may carry a fourth element
(a fill-mode / iteration suffix such as `both` or `infinite`) appended verbatim to the `--animate-*` value.
New utilities (all emitted as `--animate-*` + `@keyframes` in `tailwind-theme.css`):

| name         | keyframes                                                                                                                                                      | duration, easing, suffix      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `rise-in`    | `from { opacity:0; transform: translateY(12px) } to { opacity:1; transform:none }`                                                                             | slower, decelerate, `both`    |
| `pop-in`     | `from { opacity:0; transform: scale(.92) } to { opacity:1; transform:none }`                                                                                   | normal, decelerate, `both`    |
| `float`      | `0%,100% { transform: translateY(0) } 50% { transform: translateY(-8px) }`                                                                                     | drift, standard, `infinite`   |
| `aurora`     | `0% { transform: translate3d(-4%,-2%,0) rotate(0) } 50% { transform: translate3d(4%,3%,0) rotate(6deg) } 100% { transform: translate3d(-4%,-2%,0) rotate(0) }` | glacial, standard, `infinite` |
| `pulse-ring` | `0% { transform: scale(1); opacity:.6 } 100% { transform: scale(2.2); opacity:0 }`                                                                             | pulse, decelerate, `infinite` |
| `draw`       | `from { stroke-dashoffset: var(--wp-draw-length, 1000) } to { stroke-dashoffset: 0 }`                                                                          | slower, decelerate, `both`    |

Shadow token `card` softens to `0 1px 2px oklch(0 0 0 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.025)`; add
`shadow.elevated = 0 12px 32px -12px oklch(0 0 0 / 0.18)`. Regenerate with `pnpm tokens:build`; the
existing `test/tokens-build*.test.ts` must pass and a new assertion covers each new `--animate-*` line.

## 3. `packages/ui` additions - unit F1 (motion + card polish) and unit F2 (charts)

F1 owns: `src/motion.tsx` (new), `src/card.tsx`, `src/kpi-stat.tsx`, `src/button.tsx`,
`src/skeleton.tsx`, `src/exports-core.ts` (new exports), `src/examples/display.examples.tsx`,
`test/motion.test.tsx`, `test/card.test.tsx`, `test/kpi-stat.test.tsx`.

- `Reveal` (`'use client'`, `src/motion.tsx`): `{ as?: 'div'|'section'|'li'|'span', variant?: 'rise'|'pop'|
'fade', delayMs?: number, className?, children }` renders the element with
  `animate-rise-in|animate-pop-in|animate-fade-in motion-reduce:animate-none` and
  `style={{ animationDelay }}`. `Stagger`: `{ stepMs?: number (default 60), startMs?: number, variant?,
className?, children }` wraps each direct child in a `Reveal` with `startMs + index*stepMs`.
- `useCountUp(target: number, { durationMs = 700 } = {})` returns the displayed integer; respects
  `matchMedia('(prefers-reduced-motion: reduce)')` (jumps straight to target) and any environment without
  `requestAnimationFrame` (tests). `AnimatedNumber` `{ value: number, format?: (n:number)=>string }` renders a
  `<span className="tabular-nums">` and carries `data-target={value}` so tests assert the final value
  without waiting.
- `KpiStat` gains `tone?: 'accent'|'info'|'success'|'warning'|'danger'` (icon tile colour pair; default
  `accent`) and renders the icon in a tile (section 1) top-right; the value uses `AnimatedNumber` when
  `numericValue?: number` is supplied (otherwise the given `value` string); `hint` stays as the footer line.
  Layout: label row (label + tile), value `text-3xl`, footer row. Keep `loading` skeleton heights matching.
- `Card` radius `rounded-xl`; `CardHeader` accepts `eyebrow?: string` (rendered above the title in eyebrow
  style) and keeps `actions`. Add `CardTitle` default size `text-base`.
- `Button` primary adds `shadow-sm hover:shadow-md`; all variants gain `transition-[color,background-color,
box-shadow,transform]`.
- `Skeleton` gets a shimmer overlay (`relative overflow-hidden` + `after:` gradient using
  `via-surface/60`, `animate-shimmer motion-reduce:animate-none`), replacing `animate-pulse`.

F2 owns: `src/charts/{progress-ring,donut-chart,bar-list,chart-support}.tsx` (new), `src/exports-charts.ts`
(new), ONE line in `src/index.ts` (`export * from './exports-charts.js';`),
`src/examples/charts.examples.tsx` (new) registered in `src/examples/gallery.tsx` (F2 owns that edit),
`test/charts.test.tsx`, `test/fixtures/charts.fixtures.tsx` (add to `a11y.test.tsx` via the existing fixture
spread pattern - F2 owns that edit).

- `ProgressRing` `{ value: number (0-100), size?: 'sm'|'md'|'lg' (64/96/128px), thickness?: number,
tone?: ChartTone, label: string (aria-label), children? (centre content) }`: SVG circle track
  (`stroke-surface-2`) + value arc (`stroke-<tone>`), `strokeLinecap="round"`, arc animates on mount from 0
  via `transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none`. `role="img"`.
- `DonutChart` `{ segments: { id, label, value, tone }[], total?: number, label: string, centre?: ReactNode,
size?: 'sm'|'md'|'lg', legend?: boolean (default true) }`: stacked arcs with a 2 px gap; when every value
  is 0 draw only the track and let the caller show an empty message in `centre`; legend = list of
  `StatusDot`-style swatches + label + value + percentage, `role="list"`.
- `BarList` `{ rows: { id, label, value, max, tone?, meta?: ReactNode, leading?: ReactNode, href?: string }[],
valueFormatter?: (v,max)=>string, emptyMessage?: ReactNode }`: each row = leading slot (dot/avatar) +
  label (truncate) + right-aligned formatted value; below, a 6 px `rounded-full bg-surface-2` track with a
  `bg-<tone>` fill sized by `value/max` (clamped), width animates via `transition-[width] duration-700`.
  Rows are `<li>`; when `href` is present the row is a link. `role="list"` and each bar is
  `role="progressbar"` with `aria-valuenow/min/max` and `aria-label={label}`.
- `chart-support.ts`: `ChartTone = 'accent'|'success'|'info'|'warning'|'danger'|'muted'`,
  `TONE_STROKE`, `TONE_FILL`, `TONE_BG` class maps, `clampPercent()`, `arcPath()` helpers - unit tested.

## 4. App shell (`app/frontend/src/components/**`) - unit S1

Owns: `components/app-shell.tsx`, `components/page-header.tsx`, `components/shell/*.tsx|ts` (all),
`components/__tests__/{app-shell,page-header}.test.tsx`, `components/shell/__tests__/**`,
`app/frontend/tests/e2e/journey-support.ts` (only the theme-switch lines), catalogue pair
`en-shell-refresh.ts` / `hi-shell-refresh.ts`.

- Sidebar (`w-64`, rail `w-16`): brand row `h-16 px-4` with a `h-9 w-9 rounded-xl` mark using a subtle
  gradient (`bg-gradient-to-br from-accent to-accent-hover text-accent-fg`), `app.name` bold + workspace
  name muted; nav `px-3 py-2 gap-6`; group eyebrow `px-3 mb-1.5`; items `h-10 rounded-lg px-3 gap-3 text-sm
relative` with a left indicator (`before:` 3 px `rounded-full bg-accent` bar, visible only when active),
  icon 18 px; active `bg-sidebar-active text-sidebar-active-fg font-medium`; hover `bg-surface-2
translate-x-0.5`. Footer (`p-3 gap-3`): a wallet mini-card (`rounded-xl bg-surface-2 p-3`, eyebrow
  "Wallet", balance from `useWalletSummary` formatted with the existing `paiseToRupees`, honest muted line
  from the existing `estimatedMessagesRemaining` phrased as an estimate, and a small "Add funds" link to
  `/wallet`; hidden in rail mode; loading = skeleton, error = hidden) and a status row (realtime chip with a
  pulsing dot when live - `pulse-ring` on an absolutely positioned sibling - plus the collapse
  `IconButton`). Theme control moves to the top bar.
- Top bar `h-14 sticky bg-bg/80 backdrop-blur border-b border-border/70 px-4 lg:px-6`: left =
  hamburger (mobile) + breadcrumb label `text-sm font-semibold`; centre = search trigger as a pill
  (`h-9 w-full max-w-md rounded-full bg-surface-2 border border-transparent hover:border-border
text-subtle`) with `Kbd`; right = `extra` slot, bell, `ThemeMenu`, `LocaleMenu`, separator, `UserMenu`
  (avatar + name on `xl`).
- `ThemeMenu` becomes a `DropdownMenu` whose trigger is an `IconButton` (`data-testid="theme-switch"`,
  aria-label from `shell.theme.label`) showing Sun / Moon / Monitor (lucide) for the CURRENT choice; items
  System / Light / Dark with check marks (`data-testid="theme-option-<choice>"`). `LocaleMenu` becomes a
  `DropdownMenu` (trigger `data-testid="locale-switch"`, shows `EN` / `हि` in a small pill; items
  `data-testid="locale-option-<code>"`). Update `journey-support.ts`: replace `selectOption(...)` with
  click trigger + click option.
- `AppShell` content: `<main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8
lg:py-8">` wrapping `<Outlet/>` in `<Reveal key={pathname} variant="rise">` so every route enters with one
  rise. `PageHeader` title gets `text-2xl sm:text-3xl`, description `text-sm sm:text-base`, actions
  `gap-2`; add optional `eyebrow?: string`.
- Mobile nav: same sidebar in the sheet, wallet mini-card included, `variant="mobile"`.
- Tests: existing shell tests keep passing (theme/locale tests now click the trigger then the option; the
  test asserting `screen.getByText('owner@example.com')` still holds); add
  `shell/__tests__/theme-locale-menus.test.tsx` (open, select, provider value changes) and a sidebar test
  for the wallet mini-card (loading/hidden-on-error/value).

## 5. Dashboard (`app/frontend/src/features/dashboard/**`) - unit S2

Owns: everything under `features/dashboard/**`, catalogue pair `en-dashboard.ts` / `hi-dashboard.ts`.
Reads (never edits): `features/instances/use-instance-list.ts`, `features/wallet/api.ts`,
`features/wallet/money.ts`, `features/notifications/**`.

Layout (`flex flex-col gap-6`):

1. `PageHeader` title/description (existing keys); actions: primary "Connect a number" (`/instances`) while
   zero numbers, otherwise primary "Send a message" (`/messages`) + secondary "Connect a number".
2. KPI row `grid gap-4 sm:grid-cols-2 xl:grid-cols-4` inside `Stagger`: Connected numbers (accent, hint
   "{needsAction} need attention" or "All healthy" when >0, "None connected yet" when 0), Queued (info,
   hint "across {n} numbers"), Sent (success, hint "today, {failed} failed" - from queue-status
   workspace.failedToday), Spent today (warning, `paiseToRupees`, hint "balance {balance}" from wallet
   summary). Every KPI uses `numericValue` for count-up except the currency tile.
3. When NO linked number: `GettingStartedChecklist` redesigned as a hero card (`p-6`, `lg:grid-cols-[auto_1fr]`):
   left = `ProgressRing` (done/total ×100, size `md`, centre "{done}/{total}"), right = three step tiles in a
   `sm:grid-cols-3` grid (icon tile, title, body, status `Badge`, CTA link). Keep every existing
   `data-testid` (`getting-started-checklist`, `checklist-step-*`, `checklist-step-*-cta`).
4. Two-column `grid gap-6 lg:grid-cols-3`:
   - `lg:col-span-2` "Sending today" card (eyebrow "Numbers", title, action = "View all" link to
     `/instances`): `BarList` of `useInstanceList` items (max 6, sorted as the hook sorts): leading =
     `StatusDot` by health (connected → success, paused/needs action → warning, otherwise danger), label =
     card label (fallback instance id), value/max = `todaySent`/`effDailyCap`, meta = "waiting {n}".
     Empty = compact `EmptyState` with connect CTA (`data-testid="dashboard-numbers-empty"`), loading =
     `SkeletonRows`, error = `ErrorState` + retry (`data-testid="dashboard-numbers-error"`). This REPLACES
     the old numbers grid on the dashboard (the numbers screen keeps the full cards); delete
     `dashboard-numbers-section.tsx` and its test hooks, keep `WhyDrawer` off the dashboard.
   - "Today's outcomes" card: `DonutChart` of queue-status workspace `sentToday` (success), `failedToday`
     (danger), `waiting` (info); centre = total + "messages"; when all zero the centre reads "Nothing sent
     yet today". `data-testid="dashboard-outcomes-card"`.
5. `grid gap-6 lg:grid-cols-3`:
   - "Fleet health" card: `ProgressRing` of the mean `healthScore` over items with a card
     (`data-testid="dashboard-fleet-health"`), centre = score; side list of counts per `healthBand`
     as `Badge`s; empty when no numbers ("Connect a number to start tracking health").
   - "Wallet" card: balance `text-3xl` via `paiseToRupees`, state `Badge` (active/low/frozen tones), honest
     estimate line built from `estimatedMessagesRemaining` ("roughly {n} messages at the current top rate -
     an estimate, not a promise"), CTA "Add funds" → `/wallet`. Keep `WalletBanner` above the grid when it
     has something to say (it already returns null otherwise).
   - `RecentActivityCard` restyled as a timeline (left rail line, dot per item, title, relative time;
     unread dot stays); keep all `recent-activity-*` testids and the mark-read mutation untouched.
6. Remove `QueueStatusCard` from the dashboard (the wallet page still uses it). Delete
   `empty-dashboard.tsx` + its test if nothing imports it after the change (grep first).

Pure derivations live in `dashboard-derive.ts` (`deriveOutcomeSegments`, `deriveFleetHealth`,
`deriveKpiHints`) with exact-value unit tests; `deriveHasSentMessage` / `deriveHasWalletFunds` move there
unchanged (update `dashboard-page-derived.test.ts` imports). Component tests: `dashboard-page.test.tsx`
(stubbed fetch: empty workspace → checklist + empty bar list; populated → bars, donut legend values, fleet
score exact) using the `stubFetch` idiom in `features/instances/__tests__/use-instance-list.test.tsx`.

## 6. Auth layout + onboarding - unit S3

Owns: `components/auth-layout.tsx`, `components/__tests__/auth-layout.test.tsx`,
`features/onboarding/**` (wizard, step components, tests), `routes/onboarding.tsx` (only if needed),
catalogue pair `en-onboarding.ts` / `hi-onboarding.ts`. Does NOT touch `features/auth/**` (the forms keep
calling `AuthLayout` with the same props - all changes are inside the layout).

AuthLayout:

- Left panel (`hidden lg:flex w-[46%] relative overflow-hidden bg-sidebar`): two aurora blobs
  (`absolute rounded-full blur-3xl bg-accent/20` and `bg-info/10`, `animate-aurora
motion-reduce:animate-none`, the second with a negative `animationDelay`), a faint dot grid
  (`bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-[size:24px_24px]` masked to fade),
  brand row top-left, and a centred stack: tagline (`text-3xl font-semibold tracking-tight`) + the three
  existing honest bullets rendered as floating glass tiles (`rounded-xl border border-border/60
bg-surface/70 backdrop-blur p-4 shadow-card`, icon tile + text) inside a `Stagger` (`stepMs=120`), the
  middle tile offset `lg:translate-x-6` and all three `animate-float` with staggered delays. Footer line
  = year-free product line from the catalogue ("Built for teams that send responsibly."). Existing bullet
  texts stay byte-identical (the test asserts them).
- Right panel: brand row on mobile; form card `w-full max-w-md rounded-2xl border border-border/70
bg-surface p-8 shadow-elevated` wrapped in `Reveal variant="pop"`; heading block; `children`; footer.
  `aside` renders below the card inside a `Reveal delayMs={120}`.

Onboarding wizard (`features/onboarding/wizard.tsx` + new `wizard-layout.tsx`, `wizard-rail.tsx`):

- Desktop `lg:grid lg:grid-cols-[320px_1fr] min-h-screen`: left rail (`bg-sidebar border-r p-8`) = brand
  row, eyebrow "Workspace setup", title (existing `COPY.title`), vertical `Stepper` (existing primitive,
  `orientation="vertical"`, with one-line descriptions from the catalogue), bottom reassurance line
  ("You can change any of this later in Settings."). Right = `flex items-center justify-center p-6
lg:p-12`: `Reveal key={data.step} variant="rise"` around a `max-w-xl` card (`rounded-2xl p-8
shadow-elevated`) containing the step component, with a small "Step {n} of 5" eyebrow above the card
  title area. Below `lg`: horizontal `Stepper` on top (as today), then the card.
- Keep `wizard-loading`, `wizard-error`, every `wizard-*` testid and the `Stepper` semantics
  (`wizard.test.tsx` counts `listitem`s and `aria-current`). Loading = rail + card skeleton.
- Done step: `pop-in` success ring (a `ProgressRing value={100}` with a `Check` icon in the centre) then
  title/body/CTA in a `Stagger`.
- Step components keep their forms; only wrap their heading in the shared `WizardStepHeader`
  (title/description props) for consistent spacing - no behaviour change.

## 7. Numbers screen - unit S4

Owns: `features/instances/components/{instances-screen,instance-card,instance-card-parts}.tsx`,
`features/instances/__tests__/instance-card*.test.tsx`, `features/instances/__tests__/instances-screen*.
test.tsx`, catalogue pair `en-numbers.ts` / `hi-numbers.ts`. Never edits `use-instance-list.ts`,
`connect/**`, `api.ts`, `instance-detail-*`.

- Screen: `PageHeader` + a summary strip (`grid gap-4 sm:grid-cols-3`: Connected / Needs attention / Parked
  counts as `KpiStat` tiles inside `Card padding="sm"`) when items exist; grid of cards in a `Stagger`.
- `InstanceCard` redesign, same props and every `instance-card-*` testid preserved with the same text:
  header = state dot (pulsing sibling when connected), label `text-base font-semibold`, health `Badge`
  right; body = two labelled progress bars (today `todaySent/effDailyCap`, new conversations
  `newConversationsToday/effNewConvCap`) built with `BarList` or a local bar (values must match the
  existing `instances.card.todayProgress` / `newConversations` texts, which stay rendered as the bar
  labels); a three-cell stats strip (`rounded-lg bg-surface-2 p-3`: Queued, Next send / Not sending,
  Window); footer = pacing profile status line + disclaimer (`text-xs text-muted`, unchanged copy) and the
  "why?" link. Parked / needs-action banners stay at the top of the body.
- Countdown logic, timer invariants and the `now` seams are untouched - move the JSX only.

## 8. Verification (unit V)

`pnpm exec vitest run packages/ui packages/design-tokens packages/i18n app/frontend` green;
`pnpm exec tsc -b packages/ui/tsconfig.json app/frontend/tsconfig.json` clean; `pnpm run check:copy`,
`pnpm run check:no-raw-hex`, `pnpm run check:ui-client-directive` green; prettier `--check` and eslint on
every changed file; `wc -l` ≤ 300 on every changed `.ts/.tsx`. Screenshots (light/dark/390) of login,
onboarding, dashboard, numbers into `docs/evidence/P26b-ui/refresh/`.

## 9. Brand - unit B1

The founder's company is Sandbee (`https://sandbee.in`); the product is "WA Automation" ("WA" is the short
form of WhatsApp - never spelled out in the product name). Every brand row in the panel reads "WA
Automation" with "by Sandbee" beneath or beside it, and clicking the mark opens `sandbee.in` in a new tab.

- Constants: `app/frontend/src/components/brand/brand.ts` - `SANDBEE_SITE_URL` plus the asset paths below.
  Component: `app/frontend/src/components/brand/brand-mark.tsx` (`BrandMark`, barrel at
  `components/brand/index.ts`). Props: `size` (`'sm' | 'md' | 'lg'` - 32/36/44 px tile), `showText`
  (default `true`), `variant` (`'sidebar' | 'auth'` - text colour only), `className`, and `meta` (an
  optional extra string folded into the "by Sandbee" line as `by Sandbee · {meta}`, used for the
  workspace/company name in the expanded sidebar).
- Markup: an `<a href={SANDBEE_SITE_URL} target="_blank" rel="noopener noreferrer"
aria-label={t('brand.visitSite')} data-testid="brand-mark">` wrapping a rounded-xl, ring-bordered tile
  (`ring-1 ring-border/60`) containing `<img src="/brand/logo-64.png" srcSet="/brand/logo-64.png 1x,
/brand/logo-128.png 2x" alt="" width height>`, plus (when `showText`) a two-line block: "WA Automation"
  (`font-semibold tracking-tight`) and "by Sandbee" (`text-xs text-muted`/`text-sidebar-muted`). Hover
  scales the tile to `1.03` with `motion-reduce:transform-none`.
- Assets (already generated, never regenerated by app code): `app/frontend/public/brand/logo-{16,32,48,64,
96,128,180,192,256,512}.png`, `apple-touch-icon.png`, `favicon.ico`, served as `/brand/...`. The top-level
  `public/favicon.ico` is a copy of `public/brand/favicon.ico` so the old path keeps working.
- Usage: `components/shell/sidebar.tsx` (desktop expanded: `md` with text and `meta={companyName}`;
  collapsed rail: `sm`, no text, still a link), `components/shell/mobile-nav.tsx` (reuses `Sidebar`'s own
  mark, no separate mount), `components/auth-layout-brand-panel.tsx` and the mobile brand row in
  `components/auth-layout.tsx` (`md`/`lg`, `variant="auth"`), `features/onboarding/wizard-rail.tsx` (`md`,
  `variant="auth"`).
- Copy: `brand.product` / `brand.by` / `brand.visitSite` live in the shell-refresh catalogue pair
  (`en-shell-refresh.ts` / `hi-shell-refresh.ts`). `app.name` (`en.ts`, mirrored by `hi.ts`) became "WA
  Automation by Sandbee" - it now only backs the mobile `Sheet` title, not any visible brand row.
- `index.html`: title "WA Automation by Sandbee", `<link rel="icon">`/`apple-touch-icon` point at the brand
  assets, `<meta name="application-name">` carries the same string. No `theme-color` meta - it would need a
  raw colour literal, which the token rules forbid.
