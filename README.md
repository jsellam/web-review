# web-review

A local, GitHub-style code review tool for the changes a coding agent just
made — run entirely on your own machine.

## What it is

After your agent finishes a batch of edits, `web-review` opens the diff in a
real "Files changed"-style UI in your browser: a file tree, split or unified
view, syntax highlighting, and line-anchored comments. You review it like a
pull request. When you submit, the agent gets your verdict and every comment
back as structured JSON and acts on it — no copy-pasting, no context lost
between you and the model.

## Why not just read `git diff`

A pager gives you the diff and nothing else:

- **Comments are anchored to lines**, not typed into a chat box next to a file
  path and a line number you have to get right by hand.
- **Threads survive across rounds.** Comment, the agent replies or pushes a
  fix, and the next round shows your original comment and its reply side by
  side — even if the line it was on has since moved.
- **The agent speaks first.** It writes a summary of what it did and its own
  annotations on the lines it's unsure about, so you start reading with
  context instead of a bare diff.

## Install

```bash
git clone https://github.com/jsellam/web-review.git ~/.claude/skills/web-review
```

There is no `npm install` step to use the tool. The browser bundle
(`app/dist/`) and the server (`dist/web-review.mjs`) are committed to the
repository, already built. `dist/web-review.mjs` is a single file with no
runtime dependencies beyond Node itself (`>=18.17`) — everything it needs is
bundled in.

`npm install` is only needed if you're developing `web-review` itself; see
[Development](#development).

## Use

**Agent-driven** (see `SKILL.md` / `AGENTS.md` for the full contract): the
agent writes `.git/web-review/request.json` with a summary of its changes and
any annotations, then runs

```bash
node ~/.claude/skills/web-review/dist/web-review.mjs
```

from the repository root. The command blocks (up to `--timeout`), opens your
browser, and prints a framed JSON result once you submit.

**Standalone**, no agent involved: run the same command in any git repository
to review your own working tree or staged changes.

```bash
node dist/web-review.mjs                 # working tree vs the base it picks automatically
node dist/web-review.mjs main            # working tree vs main
node dist/web-review.mjs --staged        # index vs HEAD
```

## Flags

| Flag | Default | What it does |
|---|---|---|
| `[ref]` / `--base <ref>` | `auto` | What to diff against. `auto` diffs the working tree against `HEAD` if it's dirty, otherwise against the merge-base with the first of `main`/`master`/`develop` it finds. Any other value is a resolvable git ref. |
| `--staged` | off | Diff the index against `HEAD` instead of the working tree. |
| `--timeout <seconds>` | `540` | How long this invocation blocks waiting for a result before printing `pending` and exiting. The review itself is not cancelled — see [The JSON contract](#the-json-contract). |
| `--port <n>` | `0` (OS-assigned) | Port for the local review server. |
| `--no-open` | off (browser opens) | Don't open a browser automatically; print the URL instead. |
| `--stop` | — | Stop a review server running for this repository and exit. |

## The JSON contract

Input: `.git/web-review/request.json`, written by the agent before running the
command. All fields are optional.

```json
{
  "summary": "Markdown. What changed and why.",
  "base": "auto",
  "annotations": [
    { "file": "src/auth.ts", "line": 88, "side": "new", "body": "..." }
  ],
  "replies": [
    { "threadId": "t3", "body": "..." }
  ]
}
```

`request.json`'s `base` only takes effect when no `--base`/`--staged`/positional
ref is given on the command line; a command-line value always wins.

Output: one JSON object, framed between `<<<WEB_REVIEW_RESULT` and
`WEB_REVIEW_RESULT>>>` on stdout (the markers survive incidental logging
around them).

| `status` | Exit code | Meaning |
|---|---|---|
| `submitted` | 0 | A round finished. `verdict` is `approve`, `request_changes`, or `comment`; `threads` has the full conversation. |
| `pending` | 0 | Nobody has submitted yet within `--timeout`. `url` points at the still-running server. Run the command again. |
| `no_changes` | 0 | The resolved diff was empty; nothing to review. |
| `aborted` | 0 (130 on `SIGINT`/`SIGTERM`) | The review was cancelled or the server was stopped (`--stop`). Never treat this as approval. |
| `error` | 1 | See `message`. |

**Why `pending` is re-entrant.** Most agent harnesses cap how long a single
tool call may run, and a human reviewing a diff can easily take longer than
that. The review server runs as its own detached process, independent of the
CLI invocation that started it, so when the foreground command's `--timeout`
elapses it can print `pending` and exit without tearing anything down. Running
the command again from the same repository reattaches to that same server —
same port, same token — and resumes waiting. Do this promptly: if you let a
long time pass after a `pending` result and the review is submitted with
nobody attached to catch it, the CLI treats the server as gone and opens a
fresh round instead of returning that submission (your existing threads are
preserved either way, just not that round's verdict — the reviewer only needs
to hit submit once more).

## What lives in `.git/web-review/`

Nothing here ever touches the working tree — a review-state file at the repo
root would show up inside the diff being reviewed.

| File | Written by | Purpose |
|---|---|---|
| `request.json` | the agent | This round's summary, annotations, and replies. Read once and deleted at the start of the round. |
| `state.json` | the server | The durable review state: every thread, across every round, with its anchor and message history. |
| `session.json` | the CLI | The current round's diff range, summary, port, and token — read by the detached server process. |
| `server.json` | the server | Liveness record (`pid`, `port`, `token`, `startedAt`) so a later invocation can find and reattach to a running server. |
| `result.json` | the server | Written once, when a submission is accepted; read and deleted by the CLI invocation that's waiting for it. |
| `server.lock` | the CLI | A short-lived lock (cleared within milliseconds) that stops two near-simultaneous invocations from both spawning a server for the same repository. |

## Security

The server binds to `127.0.0.1` only, on a port chosen by the OS by default,
and every request must carry a random per-session token (embedded in the URL
that gets opened, and required on every API call). It also validates the
`Host` header against `127.0.0.1:<port>` or `localhost:<port>` and rejects
anything else.

That last check matters specifically because of DNS rebinding: without it,
any tab already open in your browser could point its own hostname at
`127.0.0.1` and, once your browser resolves it, read your repository through
this API — the loopback binding alone doesn't stop that, because the
attacker's page and the review server would both be reachable at the same
address. The `Host` check closes that gap.

## Development

```bash
npm install
npm test              # vitest run — server (node) + app (jsdom)
npm run typecheck     # tsconfig.json + tsconfig.app.json
npm run build         # vite build (app/dist) + esbuild bundle (dist/web-review.mjs)
```

`dist/` and `app/dist/` are committed. CI runs `npm run build` and then
`git diff --exit-code dist app/dist` — if you changed source and didn't
rebuild, CI fails.

## Prior art

| Tool | Feedback path | Rounds / threads | Agent summary + annotations |
|---|---|---|---|
| [diffx](https://github.com/wong2/diffx) | slash commands + server API | yes, agent replies | no |
| [difit](https://github.com/yoshiko-pg/difit) | manual "Copy Prompt" | no (localStorage) | no |
| [diffity](https://github.com/nilbuild/diffity) | `/diffity-resolve` | single pass | severity tags only |
| [revu](https://github.com/eddmann/revu) | "Export for Agent" button | no | no |

`web-review` differs in three ways at once: the agent writes its own summary
and inline annotations before a human ever looks at the diff, comment threads
persist and reanchor across as many rounds as it takes, and there is no `npm
install` — clone it and run one file.

## License

[MIT](LICENSE)
