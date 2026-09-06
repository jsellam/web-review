# Dropping Ant Design — Design

**Date:** 2026-09-06
**Status:** Approved, ready for implementation planning

## 1. Problem

The browser half of `web-review` is built entirely from Ant Design plus inline
`style={{}}` objects. There is not one `.css` file in `app/src`. Two things
follow from that.

The look is dated. antd's default blue, its dense bordered `Card`s and its dark
`Layout.Header` read as an enterprise admin dashboard, not as a code review
tool. A review is read for twenty minutes at a stretch; the screen should be
built for that.

The weight is disproportionate. `app/dist/assets/index-*.js` is 2.19 MB, and it
is committed to git — every rebuild lands in the diff being reviewed.
Twenty-two antd components and four icons are used across nine files, and only
two of the twenty-two are non-trivial to replace.

## 2. Goals

- Replace Ant Design with hand-written CSS: full control over the design, no new
  UI dependency.
- A denser, developer-tool aesthetic — the "Graphite / Linear" direction
  validated during brainstorming.
- Make additions and deletions in the diff read at a glance, without reading.
- Keep light and dark themes, and add a manual theme selector.
- Reduce the committed bundle.

## 3. Non-goals

- Changing the layout or the information architecture. Header, file sidebar and
  the stack of file cards all stay where they are.
- Touching the server, the JSON contract, or anything under `src/`.
- Introducing a CSS framework or a headless component library. No Tailwind, no
  Radix, no shadcn/ui.
- Bundling a webfont. The app is served offline by the CLI; `system-ui` and
  `ui-monospace` only.

## 4. Approach

Plain CSS with custom properties, in CSS Modules, colocated with each component.
Vite supports `.module.css` with no configuration.

Three reasons this beats a utility framework or a headless component library
*for this codebase specifically*:

1. Retheming the diff means overriding a third-party stylesheet in plain CSS
   whatever else we choose. Neither Tailwind nor shadcn helps there, and it is
   half the visual work.
2. It removes React code, not just CSS. Dark mode currently threads through
   `ConfigProvider`, `useIsDark` and prop drilling; custom properties move most
   of that into the stylesheet.
3. The server bundle is 37 KB with zero runtime dependencies. The front end can
   hold the same line.

Considered and rejected: **Tailwind v4** (same zero-runtime profile, faster to
write, noisier JSX — no decisive advantage at this size) and **Tailwind +
shadcn/ui** (fastest to a modern look, but reintroduces roughly 25–30 KB gzipped
of Radix, CVA and `tailwind-merge`, against an explicit weight goal).

## 5. Visual direction

**Graphite.** Cool greys, an indigo accent used sparingly, 13 px base with tight
line heights, monospace for every file path. Dark-leaning but fully specified in
both modes.

Diff colours are set at **intensity level 2** of three that were compared:
line backgrounds around twice the density of a first, too-timid pass;
intra-line highlights at ~50% opacity; brightened `#56d364` / `#ff7b72`; and
tinted line-number gutters, which is what carries vertical scanning during fast
scrolling. Level 3 was rejected: at that background density, syntax colours
(keyword purple, string green) start losing contrast against the fill.

## 6. Foundations

### 6.1 Tokens

`app/src/styles/tokens.css` becomes the only place in the project where a colour
is written literally.

| Family | Tokens |
|---|---|
| Surfaces | `--bg`, `--bg-raised`, `--bg-sunk` |
| Text | `--fg`, `--fg-muted`, `--fg-subtle` |
| Strokes | `--border`, `--border-strong` |
| Accent | `--accent`, `--accent-fg`, `--accent-hover` |
| Diff | `--add-bg`, `--add-hl`, `--add-gutter`, `--add-fg`, and the `--del-*` mirror |

Plus three non-chromatic scales: spacing (4/8/12/16/24), radii (4/6/8) and type
(11/12/13/15). Two families: `system-ui` and `ui-monospace`.

### 6.2 The three-state theme

Rule order is what makes the manual selector win in both directions:

1. `:root { … }` — the light palette, the absolute default.
2. `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`
3. `[data-theme="dark"] { … }`

The selector writes `data-theme` on `<html>` and remembers the choice in
`localStorage`. No attribute means auto.

### 6.3 What `theme.ts` becomes

It does not disappear. It shrinks to roughly 30 lines holding
`'auto' | 'light' | 'dark'`, the `localStorage` round-trip, and resolution to a
concrete `'light' | 'dark'`. That resolution is required because
`@git-diff-view` takes its theme as a React prop, not from CSS — see §7.2.

## 7. The diff

The diff is ~80% of the pixels on screen and is styled by
`@git-diff-view/react/styles/diff-view.css`, which the app imports at
`DiffPane.tsx:36`. Retheming it is not optional; leaving it alone would put two
design systems side by side.

Verified against the shipped stylesheet:

- It exposes **20 `--diff-*` custom properties** — content and highlight fills
  for add/del, line-number gutters, borders, hunk headers, expand rows, widget
  colours.
- They are scoped as
  `.diff-tailwindcss-wrapper[data-theme="light"] .diff-style-root { … }`, so the
  library already uses the same `data-theme` convention as §6.2.
- The stylesheet carries **no global reset** — everything is scoped under
  `.diff-tailwindcss-wrapper`, so it will not fight ours.
- `diff-view.css` and `diff-view-pure.css` are **byte-identical**. Keep the
  current import; there is no choice to make.

### 7.1 Variable mapping

`app/src/styles/diff-theme.css` maps the library's 20 variables onto our tokens:

```css
html .diff-tailwindcss-wrapper[data-theme="dark"] .diff-style-root {
  --diff-border--:                var(--border);
  --diff-add-content--:           var(--add-bg);
  --diff-add-content-highlight--: var(--add-hl);
  --diff-add-lineNumber--:        var(--add-gutter);
  /* …and the remaining 15 */
}
```

The leading `html` is deliberate. The library defines these variables on exactly
the same selector, so at equal specificity the winner would be decided by
stylesheet order — too fragile to rely on. The prefix makes the override
deterministic.

Intensity lives in `tokens.css`, not here. `diff-theme.css` is only a mapping
table; tuning the diff later means editing four token values.

### 7.2 Theme prop

`DiffPane.tsx:113` currently passes `diffViewTheme={isDark ? 'dark' : 'light'}`.
It becomes `diffViewTheme={resolved}`, fed by `theme.ts`.

### 7.3 Syntax colours

Forty `.hljs-*` classes are styled literally in the library stylesheet, outside
the variable system. We override the ten that carry the weight — `keyword`,
`string`, `comment`, `number`, `title`, `type`, `attr`, `literal`, `property`,
`punctuation` — so the diff matches the approved direction instead of staying on
the library's GitHub-like palette. Roughly 15 lines of CSS.

## 8. Component inventory

The governing constraint: **every replacement preserves its ARIA role and
accessible name.** The test suite queries by role and text, so this is both the
requirement and the safety net.

The full set, verified by enumerating every named import from `antd`, is 22
components plus the `theme` object, across nine files. They fall into five
buckets.

### 8.1 Trivial (13)

`Alert`, `Avatar`, `Badge`, `Button`, `Card`, `Empty`, `List`, `Result`,
`Skeleton`, `Space`, `Spin`, `Tag`, `Typography` become a semantic element plus
a class. `Space direction="vertical" size={16}` becomes
`display:flex; flex-direction:column; gap:16px`.

### 8.2 Better done natively (4)

| Today | Replacement | Why |
|---|---|---|
| `Checkbox` (`FileSection`) | `<input type="checkbox">` + `<label>` | Native accessible name |
| `Input.TextArea` | `<textarea>` | `placeholder` already supplies the name |
| `Radio.Group` (`SubmitDrawer`) | `<fieldset>` + native radios | Better `getByRole('radio')` behaviour than antd |
| `Collapse` (`OutdatedThreads`) | `<details>` + `<summary>` | No JS, no state |

`Segmented` (Split/Unified) becomes a radio group styled as a segmented control,
~20 lines of CSS, and gains arrow-key navigation.

`FileSection` is deliberately *not* converted to `<details>`, unlike
`OutdatedThreads`. Its open state is derived from two inputs — the `viewed` flag
and the large-file auto-collapse of `FileSection.tsx:11` — which makes it
controlled state. `<details>` suits the uncontrolled case only. The chevron
button and its two SVGs stay.

### 8.3 Real work (2)

**`Drawer` → native `<dialog>`.** `SubmitDrawer` already takes `open` and
`onClose`; the props do not change. A `useEffect` calls `showModal()` / `close()`,
and a `close` listener propagates native dismissal back to `onClose`. The
browser supplies the focus trap, Escape handling, `::backdrop` and inertness —
the whole reason `Drawer` was worth a dependency. The slide-in is a CSS
`translateX` transition. About 25 extra lines in the component.

**`Tree` → custom tree.** The collapsible tree is **kept**. A flat
directory-grouped list and a two-line flat list were both compared against it on
this repository's own file layout; with four sibling directories under
`components/`, grouping produced almost as many headers as files. Depth, not
file count, is what makes the tree worth it here. `buildFileTree()` and
`tree.test.ts` are unchanged — only the rendering is rewritten, roughly 80 lines
covering `role="tree"`, `role="treeitem"`, `aria-expanded` and arrow-key
navigation.

### 8.4 Structural and theming (2 + 1)

`Layout` (with `Header`, `Sider`, `Content`), `ConfigProvider` and the `theme`
object are all confined to `App.tsx` and are handled together in delivery step 5:
the layout becomes a CSS grid and the two theming imports simply disappear, since
§6.2 moves that job into CSS.

### 8.5 Icons

`@ant-design/icons` is dropped for four icons (`Down`, `Right`, `Robot`, `User`),
which become inline SVGs in a ~30-line `Icon.tsx`.

## 9. Testing

**Invariant: no test file is modified.** The whole `app/` suite queries by role
and accessible text, never by class or structure. A test that needs rewriting to
accommodate the new markup is a signal that behaviour broke, not that the test
needs adapting.

Two places where the invariant could have broken were checked and hold:

- `SubmitDrawer.test.tsx` always renders with `open`, so a closed `<dialog>`
  leaking its content into queries never arises.
- `DiffPane.test.tsx:85` only asserts the `/1 outdated comment/i` label, which
  `<summary>` exposes whether open or closed.

### 9.1 The jsdom blocker

jsdom 25.0.1 — the pinned version — exposes `HTMLDialogElement` as a function but
**`showModal` and `close` are `undefined`**. The `<dialog>` of §8.3 would fail
the six `SubmitDrawer` tests with a `TypeError`.

**Resolution: a six-line polyfill in `test-setup.ts`.** `showModal()` sets the
`open` attribute, `close()` removes it and dispatches `close`. Blast radius nil,
and the three finely-tuned jsdom stubs already in that file (canvas,
`ResizeObserver`, `getBoundingClientRect`) stay untouched. This does not test the
focus trap or Escape handling — browser behaviour we are deliberately delegating
rather than writing, verified by eye instead.

Rejected: upgrading jsdom to ^30. Five major versions against three stubs that
depend on jsdom internals is disproportionate risk for what it buys.

### 9.2 matchMedia stub

`test-setup.ts:22` stubs `window.matchMedia` to always return `matches: false`
with a no-op `addEventListener`. Its comment says antd's `ConfigProvider` and
`useIsDark` need it; antd leaves but the new `theme.ts` still does. The stub
stays as it is and its comment is corrected to name `theme.ts`. We do not write a
test for reacting to a system theme change, so the stub is not made to emit —
that behaviour is covered by the browser pass of §9.3.

### 9.3 What tests cannot cover

Rendering. A browser pass on a real diff covers: light, dark and the selector;
split and unified; and the four cases CSS always forgets — hunk headers, expand
rows, the empty opposite side in split view, and the widget row where the
comment composer opens.

### 9.4 Gate

`npm run build`, then `git diff --exit-code dist app/dist`, per `CLAUDE.md`.
`app/dist` is committed, so the final commit carries the rebuilt bundle.

## 10. Delivery

Six steps, one commit each, `npm test` green at every step. antd stays installed
until the last one so intermediate states compile.

1. **Foundations** — `tokens.css`, `reset.css`, the three-state `theme.ts` and
   its header selector. antd untouched and still driving its own theme.
2. **The diff** — `diff-theme.css`, the `.hljs-*` overrides, `diffViewTheme`.
   Deliberately second: it is most of the pixels and was the project's main
   unknown. **First browser pass here.**
3. **Leaf components** — `CommentComposer`, `CommentThread`, `OutdatedThreads`,
   `SummaryPanel`, `FileSection`, `FileTree`. One at a time, leaves before
   parents. The custom tree and the four SVGs land here.
4. **SubmitDrawer** — the `<dialog>` and the jsdom polyfill, isolated because it
   is the one place a test can fail for an environment reason rather than a code
   one.
5. **App.tsx** — `Layout`/`Header`/`Sider`/`Content` become a CSS grid, then
   `Result`, `Alert`, `Segmented`, `Badge`. `ConfigProvider` goes. No file
   imports antd after this step. **Second browser pass.**
6. **Cleanup and measurement** — drop `antd` and `@ant-design/icons` from
   `package.json`, rebuild, run the gate, measure `app/dist` against 2.19 MB.

## 11. Risks

**The one design risk is step 2.** If the 20 variables plus the `.hljs-*`
overrides do not produce a coherent diff, stop and revisit before committing to
steps 3–5. Everything after step 2 is mechanical.

**The weight reduction is not quantified.** `@git-diff-view` and its highlighter
also carry real weight and their share was not measured. Step 6 produces the
number; no figure is promised before it.

**The theme selector is added scope.** It was not part of "drop antd" and was
chosen knowingly during brainstorming. It is what keeps `theme.ts` alive.
