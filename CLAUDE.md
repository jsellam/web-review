# Contributing to web-review

## Commands

- `npm test` — Vitest, two projects: `server` (node) and `app` (jsdom).
- `npm run typecheck` — both tsconfigs (`tsconfig.json` for `src/`, `tsconfig.app.json` for `app/src/`).
- `npm run build` — Vite builds `app/dist`, esbuild bundles `dist/web-review.mjs`.

## Architecture

The server is deliberately thin: it shells out to `git`, serves `app/dist`, and
exposes three JSON endpoints (`GET /api/session`, `GET /api/file`,
`POST /api/review`). Diff rendering, highlighting and layout all live in the
browser bundle.

- `src/shared/` — the JSON contract (`types.ts`, `protocol.ts`), imported by both halves.
- `src/server/git/` — the only code that runs `git` (`exec.ts`); range resolution and file listing on top of it.
- `src/server/review/` — round state, thread anchoring, result payloads. Pure.
- `src/server/http/` — routes, server lifecycle, loopback security.
- `src/server/cli.ts` — argument parsing, the detached-server dance, and the framed stdout contract.
- `app/src/components/DiffPane/` — the only importer of `@git-diff-view/react` and `@git-diff-view/file`.

## Rules

- `dist/` and `app/dist/` are committed. Run `npm run build` before committing
  any source change, or CI will fail on `git diff --exit-code dist app/dist`.
- `@git-diff-view/react` and `@git-diff-view/file` are both pinned to an exact
  version and must stay confined to `DiffPane/`. Both are `0.x`; a minor bump
  can break the API — `@git-diff-view/file` is the one that builds the diff
  model in the first place, so it is no less load-bearing than `react`.
- Review state belongs in `.git/web-review/`, never in the working tree — a file
  at the repo root would show up inside the diff being reviewed.
- Anything hard should be a pure function. Side effects live in `git/exec.ts`,
  `review/state.ts`, and `http/server.ts`.
- All prose is in English.
