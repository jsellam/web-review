# web-review

A local, GitHub-style code review for the changes your coding agent just made.
The agent opens the diff in your browser, waits while you comment on the lines,
and gets your verdict back as structured JSON.

Everything runs on your machine. No account, no service, no `npm install`.

|                       Light                       |                      Dark                       |
| :-----------------------------------------------: | :---------------------------------------------: |
| ![web-review in light theme](docs/screenshots/review-light.png) | ![web-review in dark theme](docs/screenshots/review-dark.png) |

## What it does

Your agent finishes a batch of edits and, instead of dumping a wall of `git
diff` into the terminal, it opens a real "Files changed" page: file tree, split
or unified view, syntax highlighting, per-file *Viewed* checkboxes, and
line-anchored comments. You review it like a pull request and hit **Review** to
approve, request changes, or just comment.

Three things make it more than a diff viewer:

- **The agent speaks first.** Before you look at anything, it writes a summary
  of what it did and pins annotations to the lines it is unsure about — assumed
  debt, a hard-coded value, a refactor it is not certain you want. You start
  reading with context instead of a bare diff.

  ![An agent annotation anchored to a changed line](docs/screenshots/annotation-thread.png)

- **Comments are anchored to lines**, not typed into a chat box next to a file
  path and a line number you have to get right by hand.

- **Threads survive across rounds.** You comment, the agent replies or pushes a
  fix, and the next round shows your original comment and its reply side by
  side — even if the line it was on has since moved. Comments whose line no
  longer exists are marked `outdated` rather than silently dropped.

The theme follows your OS by default; `Auto` / `Light` / `Dark` in the header
overrides it and the choice sticks.

## Install

One command, whichever agent you use:

```bash
# available in every project (recommended)
npx skills add jsellam/web-review -g

# or scoped to the current repository, committed with it
npx skills add jsellam/web-review
```

[`skills`](https://github.com/vercel-labs/skills) is the open agent-skills CLI.
It asks which agents to install for and drops the skill into each one's skills
directory — `~/.claude/skills/web-review/` for Claude Code, `~/.codex/skills/`
for Codex, and so on for seventy-odd others. Skip the prompts with `-a` and
`-y`:

```bash
npx skills add jsellam/web-review -g -a claude-code -a codex -y
```

Claude picks the skill up on the next session. Nothing else to configure.

There is nothing to build and nothing to `npm install`: the browser bundle
(`app/dist/`) and the server (`dist/web-review.mjs`) are committed already
built, and `dist/web-review.mjs` is a single file with no runtime dependencies
beyond Node itself (`>=18.17`).

Later on: `npx skills update web-review`, `npx skills remove web-review`.

### An agent the CLI doesn't know about

Install it to the neutral location and point your agent at it by hand:

```bash
npx skills add jsellam/web-review -g -a universal   # ~/.config/agents/skills/web-review/
```

Then give the agent the contract. [`AGENTS.md`](AGENTS.md) is the
harness-agnostic version of `SKILL.md`: copy it into your agent's instruction
file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, a system prompt), or just
point the agent at the installed file and let it read it. Replace
`<skill path>` in it with the directory the skill landed in.

## How it gets triggered

You do not run this yourself — the agent does, as the last step of its own work.

1. **The agent decides to review.** In Claude Code the skill description says
   *"use after finishing a batch of edits, when the user asks to review changes,
   or before committing"*, so Claude reaches for it on its own. You can also
   just say so: *"open a review of what you changed"*.

2. **It writes `.git/web-review/request.json`** — a Markdown summary of what it
   did, plus any annotations it wants a second pair of eyes on.

3. **It runs the command** from the repository root:

   ```bash
   node ~/.claude/skills/web-review/dist/web-review.mjs
   ```

   Your browser opens on the diff. The command blocks while you read.

4. **You review and submit.** The command prints one JSON object, framed between
   `<<<WEB_REVIEW_RESULT` and `WEB_REVIEW_RESULT>>>`, and exits.

5. **The agent acts on it.** `approve` means stop. `request_changes` or
   `comment` means work through `threads`, apply what is right, and reply where
   it disagrees rather than complying silently. It then writes a new
   `request.json` with its replies and runs the command again — the next round
   shows your comment and its answer together.

Reviewing takes longer than most harnesses let a single tool call run, so the
review server is a detached process of its own. When the command's `--timeout`
elapses it prints `pending` and exits without tearing anything down; running it
again reattaches to the same server, same port, same token. If you submit after
the command has already exited, the result is held on disk and returned by the
next run — however long you take.

## Standalone use

No agent involved: run the same command in any git repository to review your own
working tree or staged changes. `WR` below is wherever the skill was installed —
`~/.claude/skills/web-review` for a global Claude Code install.

```bash
node $WR/dist/web-review.mjs                 # working tree vs the base it picks automatically
node $WR/dist/web-review.mjs main            # working tree vs main
node $WR/dist/web-review.mjs --staged        # index vs HEAD
```

An alias is worth it if you do this often:

```bash
alias web-review='node ~/.claude/skills/web-review/dist/web-review.mjs'
```

## Flags

| Flag | Default | What it does |
|---|---|---|
| `[ref]` / `--base <ref>` | `auto` | What to diff against. `auto` diffs the working tree against `HEAD` if it's dirty, otherwise against the merge-base with the first of `main`/`master`/`develop` it finds. Any other value is a resolvable git ref. |
| `--staged` | off | Diff the index against `HEAD` instead of the working tree. |
| `--timeout <seconds>` | `540` | How long this invocation blocks waiting for a result before printing `pending` and exiting. The review itself is not cancelled. |
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

Output: one JSON object on stdout, framed between `<<<WEB_REVIEW_RESULT` and
`WEB_REVIEW_RESULT>>>` (the markers survive incidental logging around them).

| `status` | Exit code | Meaning |
|---|---|---|
| `submitted` | 0 | A round finished. `verdict` is `approve`, `request_changes`, or `comment`; `threads` has the full conversation. |
| `pending` | 0 | Nobody has submitted yet within `--timeout`. `url` points at the still-running server. Run the command again. |
| `no_changes` | 0 | The resolved diff was empty; nothing to review. |
| `aborted` | 0 (130 on `SIGINT`/`SIGTERM`) | The review was cancelled or the server was stopped (`--stop`). Never treat this as approval. |
| `error` | 1 | See `message`. |

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

The server binds to `127.0.0.1` only, on a port chosen by the OS by default, and
every request must carry a random per-session token (embedded in the URL that
gets opened, and required on every API call). It also validates the `Host`
header against `127.0.0.1:<port>` or `localhost:<port>` and rejects anything
else.

That last check matters specifically because of DNS rebinding: without it, any
tab already open in your browser could point its own hostname at `127.0.0.1`
and, once your browser resolves it, read your repository through this API — the
loopback binding alone doesn't stop that, because the attacker's page and the
review server would both be reachable at the same address. The `Host` check
closes that gap.

## Development

```bash
npm install
npm test              # vitest run — server (node) + app (jsdom)
npm run typecheck     # tsconfig.json + tsconfig.app.json
npm run build         # vite build (app/dist) + esbuild bundle (dist/web-review.mjs)
```

`dist/` and `app/dist/` are committed. CI runs `npm run build` and then
`git diff --exit-code dist app/dist` — if you changed source and didn't rebuild,
CI fails.

## Prior art

| Tool | Feedback path | Rounds / threads | Agent summary + annotations |
|---|---|---|---|
| [diffx](https://github.com/wong2/diffx) | slash commands + server API | yes, agent replies | no |
| [difit](https://github.com/yoshiko-pg/difit) | manual "Copy Prompt" | no (localStorage) | no |
| [diffity](https://github.com/nilbuild/diffity) | `/diffity-resolve` | single pass | severity tags only |
| [revu](https://github.com/eddmann/revu) | "Export for Agent" button | no | no |

`web-review` differs in three ways at once: the agent writes its own summary and
inline annotations before a human ever looks at the diff, comment threads
persist and reanchor across as many rounds as it takes, and there is no build
step — one `npx skills add` and the agent runs a single self-contained file.

## License

[MIT](LICENSE)
