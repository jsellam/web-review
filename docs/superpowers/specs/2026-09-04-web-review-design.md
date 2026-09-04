# web-review — Design

**Date:** 2026-09-04
**Status:** Approved, ready for implementation planning

## 1. Problem

When a coding agent finishes editing, reviewing its work in the terminal is
painful: `git diff` in a pager has no line-anchored comments, no split view, no
way to hand structured feedback back to the agent. Copying file paths and line
numbers into a chat prompt by hand is the current workaround.

`web-review` gives the agent a real review loop. It opens a local, GitHub-shaped
review UI, waits while a human reviews, and returns the review to the agent as
structured JSON that the agent acts on.

## 2. Goals

- Review the current change set in a browser, GitHub "Files changed" style.
- Leave line-anchored comments, batch them as drafts, submit once with a verdict.
- Hand the review back to the agent automatically — no copy-paste.
- Iterate: the agent replies to each thread, the next round shows the
  conversation, threads carry across rounds.
- Let the agent speak first: a PR-style summary plus its own inline annotations
  on the lines it wants a human to look at.
- Work with any agent that can run a shell command, not just Claude Code.

## 3. Non-goals

- Committing, pushing, or opening pull requests. On `approve` the tool stops and
  returns control. Shipping is a separate concern with separate tools.
- Reviewing GitHub pull requests, or pushing comments to GitHub.
- Multi-user or remote review. Single machine, single reviewer, loopback only.
- Running tests, linters, or AI review passes.

## 4. Prior art

Four tools occupy this space. None combine what we need.

| Tool | Feedback path | Rounds / threads | Agent summary + annotations |
|---|---|---|---|
| [diffx](https://github.com/wong2/diffx) | slash commands + server API | yes, agent replies | no |
| [difit](https://github.com/yoshiko-pg/difit) | manual "Copy Prompt" | no (localStorage) | no |
| [diffity](https://github.com/nilbuild/diffity) | `/diffity-resolve` | single pass | severity tags only |
| [revu](https://github.com/eddmann/revu) | "Export for Agent" button | no | no |

`diffx` is closest. What is missing everywhere: the agent-authored summary and
inline annotations, a blocking CLI contract that works under any harness, and a
self-contained skill folder that needs no npm install.

## 5. User flow

1. The agent finishes editing.
2. The agent writes `.git/web-review/request.json` — a summary of what it did,
   plus optional annotations on lines it is unsure about.
3. The agent runs the CLI. The CLI computes the change set, starts a detached
   local server, opens the browser, and blocks.
4. The human reviews: file tree, split or unified diff, line numbers, syntax
   highlighting. Clicking a line opens a comment composer. Comments accumulate
   as drafts.
5. The human submits with a verdict: `approve`, `request_changes`, or `comment`.
6. The CLI prints the review as JSON on stdout and exits. The server shuts down.
7. The agent evaluates each comment. It applies what it agrees with and replies
   in the thread where it disagrees, rather than complying silently.
8. The agent re-runs the CLI. Round 2 shows a fresh diff, with round-1 threads
   re-anchored and each carrying the agent's reply. Threads can be resolved or
   reopened.
9. Repeat until `approve`, at which point the agent stops.

## 6. Architecture

The guiding split: **the server is dumb, the React app is smart.**

The server shells out to `git`, serves static files, and exposes four JSON
endpoints. Diff computation, syntax highlighting, and layout all live in the
browser bundle. This keeps the server small enough to audit and makes the hard
parts unit-testable as pure functions.

```
agent                    CLI (blocking)                human (browser)
  |
  |- writes .git/web-review/request.json
  |
  |- $ node dist/web-review.mjs --------+
  |                                     |- resolve base ref
  |                                     |- enumerate changed files
  |                                     |- spawn detached server (127.0.0.1)
  |                                     |- open browser ----------------->
  |      (blocked, up to --timeout)     |                            reviews
  |                                     |                            comments
  |                                     |<--- POST /api/review ----- submits
  |                                     |- persist state.json
  |<--- JSON on stdout -----------------+  server exits
  |
  |- evaluates, applies, replies
  |- re-runs the CLI -> round 2
```

### 6.1 The 10-minute problem

Claude Code caps a Bash call at 600 seconds. A CLI that blocks while a human
reads code would be killed mid-review. Other harnesses have their own caps.

The CLI is therefore **re-entrant**: the server is detached and outlives the
foreground process. The foreground process waits up to `--timeout` (default 540s,
comfortably under the cap), then exits with `status: "pending"`. Running the same
command again re-attaches to the live server and keeps waiting.

```
$ node dist/web-review.mjs
{"status":"pending","url":"http://127.0.0.1:53411/?t=..."}      exit 0

$ node dist/web-review.mjs
{"status":"submitted","verdict":"request_changes", ...}          exit 0
```

The command is idempotent: it starts a server or re-attaches to one. `SKILL.md`
instructs the agent: on `pending`, run it again.

## 7. CLI contract

### 7.1 Input — `.git/web-review/request.json` (optional)

Written by the agent. Without it, the tool shows a bare diff.

State lives under `.git/` rather than in the working tree on purpose: a
`.web-review/` directory at the repo root would appear as an untracked file
inside the very diff being reviewed.

```json
{
  "summary": "Add JWT refresh.\n\nThe `useAuthToken` hook centralises...",
  "base": "auto",
  "annotations": [
    { "file": "src/auth.ts", "line": 88, "side": "new",
      "body": "Hard-coded delay; I found no existing config. OK?" }
  ]
}
```

### 7.2 Flags

| Flag | Default | Meaning |
|---|---|---|
| `[ref]` / `--base <ref>` | `auto` | `auto`, `HEAD`, `staged`, or any git ref |
| `--timeout <seconds>` | `540` | foreground wait before returning `pending` |
| `--port <n>` | `0` | `0` lets the OS assign |
| `--no-open` | off | do not launch a browser |
| `--stop` | — | shut down a detached server and exit |

`auto` resolves to `HEAD` when the working tree is dirty, otherwise to
`merge-base` against the detected default branch.

### 7.3 Output — stdout

Framed by markers so it survives any incidental logging.

```
<<<WEB_REVIEW_RESULT
{ "status": "submitted",
  "verdict": "request_changes",
  "round": 1,
  "general": "Good overall, two things to revisit.",
  "threads": [
    { "id": "t3", "file": "src/auth.ts", "line": 42, "side": "new",
      "status": "open",
      "messages": [
        { "author": "user", "round": 1, "body": "Extract into a hook." }
      ] } ] }
WEB_REVIEW_RESULT>>>
```

`status` is one of:

| status | meaning | exit |
|---|---|---|
| `submitted` | the human submitted; `verdict` is set | 0 |
| `pending` | timeout reached, server still up — run again | 0 |
| `no_changes` | empty diff; browser never opened | 0 |
| `aborted` | server stopped or interrupted | 130 |
| `error` | not a repo, git failure, port failure | 1 |

Messages carry `author` (`user` or `agent`) and `round`. This is what makes a
disagreement visible: the agent's rebuttal is a message in the thread, waiting
for the human in the next round.

## 8. HTTP API

| Route | Purpose |
|---|---|
| `GET /api/session` | round, base, summary, file list with stats, threads |
| `GET /api/file?path=&side=` | full file content for one side; `204` if absent |
| `GET /api/wait` | long-poll; resolves when a review is submitted |
| `POST /api/review` | submit verdict + threads; resolves waiters, shuts down |

`GET /api/session` recomputes the file list from git on every call, so the
Refresh button picks up edits the agent made between rounds. No filesystem
watcher.

File contents are fetched lazily when a file section is expanded. A 500-file
change set loads instantly.

## 9. Data model

`.git/web-review/state.json`, rewritten on each submission:

```json
{
  "version": 1,
  "round": 2,
  "threads": [
    { "id": "t1", "file": "src/auth.ts", "side": "new",
      "anchor": { "line": 42, "content": "  const t = sign(u)",
                  "contextHash": "ab12cd" },
      "status": "open",
      "messages": [
        { "author": "user",  "round": 1, "body": "Extract into a hook." },
        { "author": "agent", "round": 2, "body": "Done: useAuthToken()." } ] } ]
}
```

`status` is `open`, `resolved`, or `outdated`.

## 10. Thread re-anchoring

The one genuinely hard algorithm, and the reason threads survive rounds. A
comment sits on `auth.ts:42`; the agent edits; line 42 becomes 47, or disappears.

An anchor stores the line number, the exact line content, and a hash of the
trimmed line plus its two neighbours. On each new round, for every thread:

1. Exact content match at the recorded line — *unchanged*.
2. Exact content match within ±25 lines — *moved*, silently re-anchored.
3. Exact content match elsewhere in the file — *moved*. On multiple candidates,
   prefer the one whose `contextHash` matches; if still ambiguous, fall to 4.
4. No match — *outdated*.

Outdated threads are never deleted. They collapse into an "Outdated" section at
the bottom of their file, with an amber badge, still readable and still returned
to the agent.

This module is pure and gets the densest test suite in the repo.

## 11. Interface

Ant Design for the shell, `@git-diff-view/react` for the diff body. The boundary
is strict: AntD never reaches inside the diff table, and the diff library knows
nothing about the app.

```
+--------------------------------------------------------------+
| web-review   base: [HEAD v]   7 files  +214 -38               |  sticky header
|                        [Split | Unified]     [ Review (5) ]   |
+--------------+-----------------------------------------------+
| Files        | +- Agent summary --------------------------+  |
|              | | Add JWT refresh.                         |  |  markdown
| v src        | | 3 points to confirm                      |  |
|   auth.ts 3  | +------------------------------------------+  |
|   api.ts     |                                               |
| v tests      | +- src/auth.ts   +48 -12   [x] Viewed   v --+ |  collapsible
|   auth.test  | |  40  41 | export function sign(u: User) { | |
|              | |  41  42 |-  const t = jwt(u)              | |  @git-diff-view
| AntD Tree    | |  42  43 |+  const t = useAuthToken(u)     | |
| badge = open | |      +- you, round 1 ------------------+  | |
| comments     | |      | Extract into a hook.            |  | |  extendData
|              | |      +- agent, round 2 ----------------+  | |
|              | |      | Done. useAuthToken() on line 43.|  | |
|              | |      |        [Resolve] [Reopen]       |  | |
|              | |      +---------------------------------+  | |
|              | |  43  44 |   return t                      | |
|              | |         ... expand 20 lines ...           | |
+--------------+-----------------------------------------------+
```

Borrowed from GitHub deliberately: the per-file **Viewed** checkbox that collapses
and greys the file, comments held as **drafts** until one submission, and the
submit step as an AntD `Drawer` with a general comment and a verdict
`Radio.Group`.

`@git-diff-view/react` gives us the comment affordances natively:
`onAddWidgetClick` (the gutter button), `renderWidgetLine` (the composer being
typed), `extendData` + `renderExtendLine` (persisted threads). It also takes full
old and new file contents rather than a diff blob, so context expansion needs no
round trip and a new file is simply `oldContent: ""`.

Theming: `ConfigProvider` with `darkAlgorithm` / `defaultAlgorithm` following
`prefers-color-scheme`. AntD design tokens feed the CSS variables of the diff
component, so diff greens and reds belong to the same palette as the shell.
Highlighting uses `lowlight`, already a hard dependency of the diff library —
shipping Shiki as well would mean two highlighters in one bundle.

## 12. Repo layout

Module boundaries follow testability: everything hard is a pure function, and
side effects are confined to three files, marked below.

```
src/shared/types.ts        JSON contract — imported by server AND app
src/server/
  cli.ts                   flags, orchestration, stdout protocol
  git/  exec.ts            [side effect] execFile('git')
        range.ts           resolve base: auto | HEAD | staged | <ref>
        files.ts           enumerate changed files + stats, incl. untracked
  review/ request.ts       read and validate request.json
          state.ts         [side effect] .git/web-review/state.json
          anchor.ts        re-anchor threads across rounds
          result.ts        build the stdout payload
  http/ server.ts          [side effect] node:http, detach, lifecycle
        routes.ts, static.ts, security.ts
app/src/
  api/client.ts            typed client for the four endpoints
  state/draft.ts           draft comments (zustand)
  components/
    DiffPane/              the ONLY place @git-diff-view is imported
    FileTree/  FileHeader/  SummaryPanel/
    CommentThread/  CommentComposer/  SubmitDrawer/
```

`DiffPane/` exists to contain the risk of a `0.x` dependency: a breaking change
in `@git-diff-view/react` touches one directory. The version is pinned exactly.

## 13. Build and distribution

Nothing is compiled on the user's machine. Two build steps produce two committed
artifacts:

```
npm run build
  |- vite build     app/src        -> app/dist/           React, AntD, diff view
  |- esbuild        src/server/**  -> dist/web-review.mjs  single ESM file, node18+
```

Installation is a clone; use is `node <skill>/dist/web-review.mjs`. No
`npm install`, no `node_modules`, no network, works offline. TypeScript and small
server-side libraries stay available because esbuild bundles them.

Committing build artifacts costs merge conflicts once there are contributors.
Two mitigations:

- `.gitattributes` marks `dist/** -diff -merge=ours linguist-generated`, so
  conflicts are resolved by rebuilding and GitHub hides the bundle from diffs.
- CI runs `npm run build && git diff --exit-code dist app/dist`. A stale bundle
  fails the build — the classic failure mode of this setup, made impossible.

## 14. Documentation

Four files, two distinct audiences, all in English.

| File | Audience | Contents |
|---|---|---|
| `README.md` | a human discovering it | what and why, demo, install, JSON contract, dev |
| `SKILL.md` | Claude Code **using** it | frontmatter, trigger conditions, exact steps |
| `AGENTS.md` | Codex/Cursor/others **using** it | same operational content, no Claude frontmatter |
| `CLAUDE.md` | an agent **contributing** to the repo | build and test commands, architecture map, rebuild-dist rule |

`SKILL.md` and `AGENTS.md` both carry the instruction that matters: evaluate each
comment, apply what is right, and reply in the thread when you disagree instead
of complying silently. On `pending`, run the command again. On `approve`, stop.

## 15. Testing

Vitest, one config with two projects: `server` in a node environment, `app` in
jsdom.

- **Server unit** — `range`, `files`, `anchor`, `result`, `request` against diff
  fixtures. `anchor` carries the densest cases: unchanged, shifted, duplicated
  content, deleted line, renamed file, whole file rewritten.
- **Server integration** — `git init` in a temp directory, write and edit files,
  boot on port 0, hit every endpoint, POST a review, assert the resolved payload.
  This is the test that proves the blocking loop works end to end, including
  `pending` on timeout and re-attachment.
- **App unit** — `draft` store transitions, the API client, thread grouping.
- **Component** — React Testing Library on the path that matters: click a line,
  compose, draft appears, submit, payload shape is correct. Plus outdated-thread
  rendering.

## 16. Edge cases

- **Untracked files** — `git diff` does not list them; `files.ts` adds them via
  `git ls-files --others --exclude-standard`. They then need no special handling,
  since the diff component takes contents rather than a patch: `oldContent` is
  simply empty.
- **Empty diff** — exit `no_changes` immediately, no browser.
- **Not a git repository** — clear message, exit 1.
- **Renames** — `git diff -M`; the thread anchor follows the new path.
- **Binary and generated files** — listed with a placeholder row, no content.
- **Very large files** — diffs over 1000 lines collapse by default; only expanded
  files mount into the DOM.
- **Browser closed without submitting** — the server stays up; re-running the CLI
  re-attaches and reprints the URL.
- **Interrupt (Ctrl-C)** — exit `aborted`, so the agent never mistakes a
  cancellation for approval.
- **Stale server record** — `server.json` holds pid, port and token; liveness is
  checked with `process.kill(pid, 0)` plus a ping before re-attaching.

## 17. Security

The server listens on `127.0.0.1` only, on an OS-assigned port, with a random
token in the URL that the app then sends as an `X-Review-Token` header. The
`Host` header is validated against `127.0.0.1:<port>` and `localhost:<port>`.

Without the Host check, any website open in the same browser could read the
project's source through DNS rebinding. Three lines of code, but they matter.

## 18. Deferred

Explicitly out of the first version, recorded so they are not re-litigated:
GitHub PR review, suggested-change blocks the agent applies verbatim, keyboard
navigation, review history beyond the current change set, multiple concurrent
reviews in one repository.
