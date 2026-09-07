# `--prepare`: giving the agent the diff instead of making it hunt — Design

**Date:** 2026-09-07
**Status:** Approved, ready for implementation planning

## 1. Problem

`SKILL.md` asks the agent to write `request.json` with line-anchored
annotations before the review opens:

```json
{ "file": "src/auth.ts", "line": 88, "side": "new", "body": "..." }
```

`line` must be exact. `openRound` feeds it to `makeAnchor`, which throws when
the line is out of range. So before it can write a single annotation, the agent
has to establish two things it cannot get from the CLI: what actually changed,
and the exact line number of anything it wants to comment on.

It gets them the only way it can — by reading and grepping the changed files
one at a time. Every one of those is an LLM round trip. On a ten-file change
that is ten round trips spent rebuilding information `git` could have handed
over in one.

## 2. Goals

- One command gives the agent everything it needs to write `request.json`:
  the resolved range, the changed files, and the diff with both old and new
  line numbers already attached.
- Line numbers that are correct by construction, so `makeAnchor` cannot throw
  on an annotation the agent guessed wrong.
- Bounded output. The mode must stay cheaper than the greps it replaces, on
  this repository, which commits `dist/` and `app/dist/`.
- Read-only and idempotent. Callable at any point without disturbing a round.

## 3. Non-goals

- Deciding *where* to annotate. That is a semantic judgement; the script
  supplies material, not opinions.
- Changing the `request.json` schema. Annotations stay `{file, line, side, body}`.
- Changing the framed `<<<WEB_REVIEW_RESULT` contract or the `CliResult` shape.
- Any heuristic that guesses which paths are generated. See §6.
- Touching the browser half.

## 4. The contract

```
node dist/web-review.mjs --prepare [--base <ref> | --staged]
```

Read-only and idempotent: it does not open a round, does not read or consume
`request.json`, does not write `state.json`, does not spawn a server, does not
take the spawn lock. It branches out of `main()` immediately after `gitDir`
resolution and exits.

The range comes from `resolveRange(options.base)` — `auto` by default. Note
that `main()`'s normal path prefers `request.base` over `auto`, and
`request.json` does not exist yet at prepare time. An agent that intends to
set `request.base` must pass the same ref here as `--base`. This is documented
in `SKILL.md`, not worked around.

**Output is plain text on stdout — deliberately not framed JSON.** The frame
carries a `CliResult`, and `--prepare` produces no round. More concretely, a
diff encoded as a JSON string is escaping (`\n`, `\"`) on every line of content
that exists to be read by eye; the token overhead would work directly against
the point of the mode. Errors are plain text on stderr with exit 1. The mode is
plain-text end to end, never a hybrid.

`no changes` and exit 0 when the range is empty.

## 5. Output format

Two number columns, old and new, then the marker, then the line verbatim. A
deleted line has no new-side number and an added line has no old-side number;
the missing one is `.`. The format is unambiguous on its own, which is why it
was chosen over a single column plus a legend the agent has to hold in mind.

```
range: working tree vs HEAD (base 3f2a1c9)
4 files changed

  old  new
== src/server/cli.ts  modified  +2 -1
@@ -44,7 +44,9 @@
   44   44    port: number;
   45   45    open: boolean;
   46    .  - stop: boolean;
    .   46  + stop: boolean;
    .   47  + prepare: boolean;
   47   48    serveInternal: boolean;
```

- The `old  new` header prints **once**, at the top of the output.
- Number columns are right-aligned to width 5. A wider number simply takes more
  room; alignment is cosmetic, never semantic.
- After the two columns: two spaces, one marker character (`-`, `+`, or space),
  one space, then the line content verbatim.
- `@@` hunk headers are printed as git emits them, on their own line, with no
  number columns.
- File header: `== <path>  <status>  +<additions> -<deletions>`, and for a
  rename `== <newpath>  renamed from <oldpath>  +N -M`.
- An untracked file has no `git diff` output and therefore no `@@` header. It
  is rendered as a pure addition numbered from 1, under the ordinary
  `== <path>  added  +N -0` header. Nothing marks it as untracked: the
  distinction changes nothing the agent does with it.

To annotate, the agent reads a number off the column matching the `side` it
wants: the `new` column for `side: "new"`, the `old` column for `side: "old"`.

## 6. Bounds

A "diff line" below means one line of rendered body — context, addition, deletion,
or `@@` header. File headers and the notes the bounds themselves emit do not
count.

Without bounds this repository's committed bundles would make `--prepare` far
more expensive than the greps it replaces.

- **Binary** — header only:
  `== app/dist/assets/logo.png  modified  binary — not shown`
- **Per file**, over 400 diff lines — header plus a note, no body:
  `== app/dist/index.js  modified  +4200 -3800  — too large, truncated; read the file yourself if you need it`
  Checked twice: against `additions + deletions` before the file is diffed at
  all, and against the rendered line count afterwards, which context lines can
  push over the bound on their own.
- **Total**, over 2000 diff lines — every remaining file as a header plus
  `— omitted, output limit reached`

There is deliberately **no path-based rule** for generated directories. The
per-file bound already handles them: a bundle diff is large, so it truncates to
a header, and therefore consumes almost none of the total budget. A blocklist
would be one more thing to maintain and would be wrong on the first repository
that lays its build output out differently.

Nothing is ever withheld silently. Every bound that fires says so, in place,
on the file it applies to.

## 7. Structure

`src/server/git/diff.ts`

- `readFileDiff(entry, range, opts): Promise<string>` — the only side effect.
  Runs `git diff -M -U3 <base> -- <path>` (both paths for a rename, so `-M`
  can still see it) **per file**, not once for the range.
- `numberHunks(text): NumberedLine[]` — pure. Skips everything before the
  first `@@`, then walks `@@ -a,b +c,d @@` assigning
  `{ kind, old: number | null, new: number | null, text }` to every line.
  `kind` is `'hunk' | 'context' | 'add' | 'del'`.

Diffing per file rather than splitting one combined diff is deliberate. It
removes the need to parse the paths out of `diff --git a/… b/…` headers —
where git quotes anything non-ASCII — and the authoritative path list already
comes from `listChangedFiles`. It also means an oversized or binary file is
never diffed at all: `additions + deletions` is known up front, so the bound
is applied before the work, not after.

`src/server/review/prepare.ts`

- `renderPrepare(range, files, diffs, untracked, caps): string` — pure.
  All formatting and all bound logic. Takes the file list and the parsed
  diffs; returns the finished text.

`src/server/cli.ts` wires the two together and writes the result to stdout.
The split keeps `git/` as the only place that runs `git` and leaves everything
hard as a pure function, per `CLAUDE.md`.

Untracked file contents are read the way `listUntracked` already reads them,
and are subject to the same bounds.

## 8. Testing

Colocated, matching the repo's convention.

`src/server/git/diff.test.ts` — `numberHunks` over multiple hunks, a header
with no line count, an empty context line, and `\ No newline at end of file`.
`readFileDiff` against a real temp repository: one file in isolation, a rename
still seen as a rename under a pathspec, an untracked file (empty diff), and a
staged range reading the index rather than the working tree.

`src/server/review/prepare.test.ts` — column alignment; the marker/`.` pairing
for each of the three line kinds; the binary, per-file and total bounds each
firing and each announcing itself; an untracked file numbered from 1; the
empty range.

`src/server/cli.test.ts` — `parseArgs` accepts `--prepare` and combines it with
`--base`/`--staged`.

An end-to-end check in `src/server/cli.e2e.test.ts` that `--prepare` on a real
temp repository prints a diff, leaves `state.json` and `request.json`
untouched, and starts no server.

## 9. Documentation and build

`SKILL.md` and `AGENTS.md` gain a step before writing `request.json`: run
`--prepare`, read the numbered diff, take annotation line numbers from the
column matching the side. Both files carry the same text, as they do today.
Without this the mode is dead code.

`dist/` and `app/dist/` are committed, so `npm run build` runs before the
commit or CI fails on `git diff --exit-code dist app/dist`.
