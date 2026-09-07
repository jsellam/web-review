# web-review — instructions for coding agents

This file is the harness-agnostic version of `SKILL.md`. Copy it into your
agent's instruction file (`AGENTS.md`, `.cursorrules`, a system prompt) or point
your agent at it.

# web-review

Run a human code review of your own changes and act on the result.

## Steps

1. Write `<git-dir>/web-review/request.json` describing what you did, where
   `<git-dir>` is what `git rev-parse --absolute-git-dir` prints. Resolve it;
   do not assume `.git/`, which in a worktree is a *file* pointing elsewhere,
   so the literal path `.git/web-review/` can neither be read nor created:

   ```bash
   mkdir -p "$(git rev-parse --absolute-git-dir)/web-review"
   ```

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

2. Run the command from the repository root:

   ```bash
   node <skill path>/dist/web-review.mjs
   ```

3. Read the JSON printed between `<<<WEB_REVIEW_RESULT` and `WEB_REVIEW_RESULT>>>`.

## What each status means

- `pending` — the reviewer is still reading. **Run the command again**, from
  the same repository, exactly as before — do not write `request.json` again:
  the round is already open and your summary and annotations are already in
  it. It is not a result: do not treat it as approval and do not start
  editing. The review server keeps running in the background even after this
  command exits, so re-running reattaches to it instead of starting over. If the human submits after this command has already exited,
  the submission is held for you: the next run of the command returns it,
  however long you wait before running it again.
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
of what you changed, then run the command again to open the next round.
Threads carry across rounds, so the human sees your reply next to their
original comment.

Threads with `"status": "outdated"` were anchored to lines that no longer exist.
Read them for intent; do not try to apply them literally.
