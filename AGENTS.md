# web-review — instructions for coding agents

This file is the harness-agnostic version of `SKILL.md`. Copy it into your
agent's instruction file (`AGENTS.md`, `.cursorrules`, a system prompt) or point
your agent at it.

# web-review

Open a human code review of your own changes and act on the result.

**By default you do not review the code.** You describe what you changed, open
the page, and hand it to the human — the comments are theirs to write. Only
annotate lines yourself when the user explicitly asked you to review your work
before opening (see [Reviewing your own work first](#reviewing-your-own-work-first)).

## Steps

1. Write `<git-dir>/web-review/request.json`, where `<git-dir>` is what
   `git rev-parse --absolute-git-dir` prints. Resolve it; do not assume
   `.git/`, which in a worktree is a *file* pointing elsewhere, so the literal
   path `.git/web-review/` can neither be read nor created:

   ```bash
   mkdir -p "$(git rev-parse --absolute-git-dir)/web-review"
   ```

   ```json
   {
     "summary": "Markdown. What changed and why."
   }
   ```

   A summary is all you write by default. No `annotations` key.

2. Open the review, from the repository root. `--timeout 0` returns as soon as
   the page is up instead of blocking, so you can show the human the address:

   ```bash
   node <skill path>/dist/web-review.mjs --timeout 0
   ```

   It opens the browser itself and prints a `pending` result carrying the
   address:

   ```json
   { "status": "pending", "url": "http://127.0.0.1:53411/?t=8f2c…" }
   ```

   Any other status here is a real outcome — read it and stop; do not go on to
   step 3.

3. Tell the user, in your reply text where they can actually see it — not
   buried in a tool call — the URL and that you are blocked:

   > Review open: http://127.0.0.1:53411/?t=8f2c…
   > I opened it in your browser; if nothing came up, use the link above.
   > Waiting for you to submit the review before I continue.

   Print the `url` exactly as it came back: the token in it is what
   authenticates the page.

4. Wait for the submission, from the same repository:

   ```bash
   node <skill path>/dist/web-review.mjs
   ```

   Do not write `request.json` again — the round is already open and your
   summary is already in it.

5. Read the JSON printed between `<<<WEB_REVIEW_RESULT` and
   `WEB_REVIEW_RESULT>>>`.

Do not commit, push, or move on to other work while a round is open. You are
waiting on the human.

## What each status means

- `pending` — no submission yet. In step 2 that is the normal case and means
  the page is up. In step 4 it means the reviewer is still reading: **run the
  command again**, from the same repository, exactly as before. It is not a
  result: do not treat it as approval and do not start editing. The review
  server keeps running in the background even after this command exits, so
  re-running reattaches to it instead of starting over. If the human submits
  after this command has already exited, the submission is held for you: the
  next run returns it, however long you wait before running it again. Repeat
  the address and the "waiting" line to the user each time you re-run, so they
  keep the link in view.
- `no_changes` — there was nothing to review.
- `aborted` — the review was cancelled, or the server was stopped. This is
  **not** approval.
- `error` — read `message`.
- `submitted` — a round finished. Read `verdict`:
  - `approve` — **stop.** Do not commit, push, or open a pull request unless
    the user asks separately.
  - `request_changes` or `comment` — act on `threads`, below.

## Acting on `request_changes` or `comment`

Evaluate each comment on its merits. Apply what is right. Where you disagree,
say so instead of complying silently: put your reasoning in a reply and let the
human decide.

```json
{
  "replies": [
    { "threadId": "t3",
      "body": "Kept the inline version: extracting it would need the request context, which the hook cannot reach." }
  ]
}
```

Write that to the same `request.json` as in step 1, together with a `summary`
of what you changed, then run steps 2–5 again to open the next round.
Threads carry across rounds, so the human sees your reply next to their
original comment.

Threads with `"status": "outdated"` were anchored to lines that no longer exist.
Read them for intent; do not try to apply them literally.

## Reviewing your own work first

Only when the user explicitly asks for it — "review your changes before opening
it", "flag anything you're unsure about", "do a pass first". Otherwise skip
this section entirely.

Get the changed files and their line numbers in one call, before step 1, from
the repository root:

```bash
node <skill path>/dist/web-review.mjs --prepare
```

It prints the diff with the line number each line has on each side:

```
  old  new
== src/auth.ts  modified  +1 -1
@@ -85,5 +85,5 @@
   85   85      const user = req.user;
   86   86      const token = sign(user);
   87   87      audit(user, token);
   88    .  -   await wait(500);
    .   88  +   await wait(delay);
   89   89      return token;
```

Read the number off the column matching the `side` you want to annotate:
the `new` column for `side: "new"`, the `old` column for `side: "old"`.
Do not count lines yourself, and do not grep for them.

This is read-only: it opens no review and can be run at any time. A file
that is binary or very large is shown as a header only, and says so —
read that one yourself if you need it. A file well within that limit can
still come out as a header only, marked `— omitted, does not fit the
remaining output budget`, once the total output grows too large; a
bodyless header does not by itself mean the file is unchanged, so check
the note next to it. A renamed file is headed by its **new** path
(`== src/new.ts  renamed from src/old.ts`) — always put that new path in
`file`, on both sides; the old path still anchors the comment, but the
browser keys threads by the new path and filters out anything else, so the
comment would silently never appear.

Then add an `annotations` array to the `request.json` of step 1:

```json
{
  "summary": "Markdown. What changed and why.",
  "annotations": [
    { "file": "src/auth.ts", "line": 88, "side": "new",
      "body": "Hard-coded delay; I found no existing config. OK?" }
  ]
}
```

Annotations are for genuine uncertainty — hesitations, assumed debt, things
worth a second pair of eyes. Do not annotate lines you are confident about.
Take every `line` from the columns printed by `--prepare`; a line number that
does not exist is an error, not a near miss.
