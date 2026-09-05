#!/usr/bin/env node

// src/server/cli.ts
import { spawn } from "node:child_process";
import { readFile as readFile6, rm as rm3, writeFile as writeFile3 } from "node:fs/promises";
import { join as join6 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/shared/protocol.ts
var RESULT_START = "<<<WEB_REVIEW_RESULT";
var RESULT_END = "WEB_REVIEW_RESULT>>>";
function frameResult(result) {
  return `${RESULT_START}
${JSON.stringify(result, null, 2)}
${RESULT_END}`;
}

// src/server/git/exec.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var run = promisify(execFile);
var GitError = class extends Error {
  constructor(args, stderr, code) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
    this.code = code;
    this.name = "GitError";
  }
};
async function git(args, opts) {
  return gitRaw(args, opts).then((out) => out.replace(/\n$/, ""));
}
async function gitRaw(args, opts) {
  try {
    const { stdout } = await run("git", args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout;
  } catch (error) {
    const e = error;
    throw new GitError(args, e.stderr ?? "", e.code ?? 1);
  }
}
async function gitOk(args, opts) {
  try {
    await git(args, opts);
    return true;
  } catch {
    return false;
  }
}
async function repoRoot(opts) {
  return git(["rev-parse", "--show-toplevel"], opts);
}
async function gitDir(opts) {
  return git(["rev-parse", "--absolute-git-dir"], opts);
}

// src/server/git/range.ts
var DEFAULT_BRANCH_CANDIDATES = ["main", "master", "develop"];
async function isDirty(opts) {
  return (await git(["status", "--porcelain"], opts)).trim().length > 0;
}
async function detectDefaultBranch(opts) {
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    if (await gitOk(["rev-parse", "--verify", "--quiet", candidate], opts)) return candidate;
  }
  return null;
}
async function resolveRange(spec, opts) {
  if (spec === "staged") {
    return { base: "HEAD", label: "index vs HEAD", staged: true };
  }
  if (spec === "HEAD") {
    return { base: "HEAD", label: "working tree vs HEAD", staged: false };
  }
  if (spec === "auto") {
    if (await isDirty(opts)) {
      return { base: "HEAD", label: "working tree vs HEAD", staged: false };
    }
    const branch = await detectDefaultBranch(opts);
    if (!branch) {
      return { base: "HEAD", label: "working tree vs HEAD", staged: false };
    }
    const base2 = await git(["merge-base", branch, "HEAD"], opts);
    return { base: base2, label: `branch vs ${branch}`, staged: false };
  }
  if (!await gitOk(["rev-parse", "--verify", "--quiet", `${spec}^{commit}`], opts)) {
    throw new Error(`web-review: unknown base ref: ${spec}`);
  }
  const base = await git(["rev-parse", spec], opts);
  return { base, label: `working tree vs ${spec}`, staged: false };
}

// src/server/git/files.ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
var NUL = "\0";
function diffArgs(range, extra) {
  return range.staged ? ["diff", "--cached", "-M", "-z", ...extra, range.base] : ["diff", "-M", "-z", ...extra, range.base];
}
function parseNumstat(output) {
  const counts = /* @__PURE__ */ new Map();
  const fields = output.split(NUL);
  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    const tabIdx1 = field.indexOf("	");
    if (tabIdx1 === -1) {
      i++;
      continue;
    }
    const tabIdx2 = field.indexOf("	", tabIdx1 + 1);
    if (tabIdx2 === -1) {
      i++;
      continue;
    }
    const added = field.substring(0, tabIdx1);
    const deleted = field.substring(tabIdx1 + 1, tabIdx2);
    const path = field.substring(tabIdx2 + 1);
    if (path === "") {
      const newPath = fields[i + 2] ?? "";
      if (newPath) {
        counts.set(newPath, {
          additions: added === "-" ? 0 : Number(added),
          deletions: deleted === "-" ? 0 : Number(deleted),
          binary: added === "-" && deleted === "-"
        });
      }
      i += 3;
    } else {
      counts.set(path, {
        additions: added === "-" ? 0 : Number(added),
        deletions: deleted === "-" ? 0 : Number(deleted),
        binary: added === "-" && deleted === "-"
      });
      i += 1;
    }
  }
  return counts;
}
var STATUS_MAP = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  T: "modified"
};
async function listChangedFiles(range, opts) {
  const [numstat, nameStatus] = await Promise.all([
    git(diffArgs(range, ["--numstat"]), opts),
    git(diffArgs(range, ["--name-status"]), opts)
  ]);
  const counts = parseNumstat(numstat);
  const entries = [];
  const records = nameStatus.split(NUL).filter((r) => r.length > 0);
  let i = 0;
  while (i < records.length) {
    const code = records[i].charAt(0);
    const status = STATUS_MAP[code] ?? "modified";
    const isRename = code === "R";
    if (isRename) {
      const oldPath = records[i + 1] ?? "";
      const path = records[i + 2] ?? oldPath;
      entries.push({
        path,
        oldPath,
        status,
        ...counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
      });
      i += 3;
    } else {
      const path = records[i + 1] ?? "";
      entries.push({
        path,
        oldPath: status === "added" ? null : path,
        status,
        ...counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
      });
      i += 2;
    }
  }
  if (!range.staged) entries.push(...await listUntracked(opts));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function listUntracked(opts) {
  const output = await git(["ls-files", "--others", "--exclude-standard", "-z"], opts);
  const paths = output.split(NUL).filter((p) => p.length > 0);
  return Promise.all(
    paths.map(async (path) => {
      const content = await readFile(join(opts.cwd, path), "utf8").catch(() => null);
      const binary = content === null || content.includes(NUL);
      return {
        path,
        oldPath: null,
        status: "added",
        additions: binary || content === null ? 0 : countLines(content),
        deletions: 0,
        binary
      };
    })
  );
}
function countLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}
async function readSide(path, side, range, opts) {
  if (side === "old") {
    const refExists = await gitOk(
      ["rev-parse", "--verify", "--quiet", `${range.base}^{commit}`],
      opts
    );
    if (!refExists) {
      await git(["rev-parse", "--verify", `${range.base}^{commit}`], opts);
      throw new Error("unreachable");
    }
    const fileExists = await gitOk(["cat-file", "-e", `${range.base}:${path}`], opts);
    if (!fileExists) return null;
    return gitRaw(["show", `${range.base}:${path}`], opts);
  }
  if (range.staged) {
    const exists = await gitOk(["cat-file", "-e", `:${path}`], opts);
    if (!exists) return null;
    return gitRaw(["show", `:${path}`], opts);
  }
  const full = join(opts.cwd, path);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  return readFile(full, "utf8");
}

// src/server/review/request.ts
import { readFile as readFile2, rm } from "node:fs/promises";
import { join as join2 } from "node:path";
var REQUEST_FILE = "request.json";
var RequestError = class extends Error {
  constructor(message2) {
    super(`web-review: ${message2}`);
    this.name = "RequestError";
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isENOENT(error) {
  return isRecord(error) && error.code === "ENOENT";
}
function asString(value, field, fallback) {
  if (value === void 0 && fallback !== void 0) return fallback;
  if (typeof value !== "string") throw new RequestError(`${field} must be a string`);
  return value;
}
function asSide(value, field) {
  if (value !== "old" && value !== "new") {
    throw new RequestError(`${field} must be "old" or "new"`);
  }
  return value;
}
function asArray(value, field) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) throw new RequestError(`${field} must be an array`);
  return value;
}
function toLineComment(listField) {
  return (raw, index) => {
    const field = `${listField}[${index}]`;
    if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);
    const line = raw["line"];
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw new RequestError(`${field}.line must be an integer >= 1`);
    }
    return {
      file: asString(raw["file"], `${field}.file`),
      line,
      side: asSide(raw["side"], `${field}.side`),
      body: asString(raw["body"], `${field}.body`)
    };
  };
}
function toReply(raw, index) {
  const field = `replies[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);
  return {
    threadId: asString(raw["threadId"], `${field}.threadId`),
    body: asString(raw["body"], `${field}.body`)
  };
}
function validateRequest(raw) {
  if (!isRecord(raw)) throw new RequestError("request.json must be a JSON object");
  return {
    summary: asString(raw["summary"], "summary", ""),
    base: asString(raw["base"], "base", "auto"),
    annotations: asArray(raw["annotations"], "annotations").map(toLineComment("annotations")),
    replies: asArray(raw["replies"], "replies").map(toReply)
  };
}
function defaults() {
  return { summary: "", base: "auto", annotations: [], replies: [] };
}
async function readRequest(stateDir) {
  let raw;
  try {
    raw = await readFile2(join2(stateDir, REQUEST_FILE), "utf8");
  } catch (error) {
    if (isENOENT(error)) return defaults();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestError("request.json is not valid JSON");
  }
  return validateRequest(parsed);
}
async function consumeRequest(stateDir) {
  const request = await readRequest(stateDir);
  await rm(join2(stateDir, REQUEST_FILE), { force: true });
  return request;
}
var VERDICTS = ["approve", "request_changes", "comment"];
function asVerdict(value) {
  if (typeof value !== "string" || !VERDICTS.includes(value)) {
    throw new RequestError(`verdict must be one of: ${VERDICTS.join(", ")}`);
  }
  return value;
}
function asIdList(value, field) {
  return asArray(value, field).map((id, index) => {
    if (typeof id !== "string") throw new RequestError(`${field}[${index}] must be a string`);
    return id;
  });
}
function validateSubmit(raw) {
  if (!isRecord(raw)) throw new RequestError("submission must be a JSON object");
  return {
    verdict: asVerdict(raw["verdict"]),
    general: asString(raw["general"], "general", ""),
    newComments: asArray(raw["newComments"], "newComments").map(toLineComment("newComments")),
    replies: asArray(raw["replies"], "replies").map(toReply),
    resolved: asIdList(raw["resolved"], "resolved"),
    reopened: asIdList(raw["reopened"], "reopened")
  };
}

// src/server/review/anchor.ts
import { createHash } from "node:crypto";
var SEARCH_WINDOW = 25;
function splitLines(content) {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function contextHash(lines, index) {
  const window = [lines[index - 1] ?? "", lines[index] ?? "", lines[index + 1] ?? ""];
  const normalised = window.map((line) => line.trim()).join("\n");
  return createHash("sha1").update(normalised).digest("hex").slice(0, 12);
}
function makeAnchor(lines, line) {
  const content = lines[line - 1];
  if (content === void 0) {
    throw new Error(`web-review: line ${line} is out of range (${lines.length} lines)`);
  }
  return { line, content, contextHash: contextHash(lines, line - 1) };
}
function relocate(anchor, lines) {
  if (lines[anchor.line - 1] === anchor.content) {
    return { line: anchor.line, status: "unchanged" };
  }
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === anchor.content) matches.push(i + 1);
  }
  if (matches.length === 0) return { line: null, status: "outdated" };
  const near = nearest(matches, anchor.line, SEARCH_WINDOW);
  if (near !== null) return { line: near, status: "moved" };
  if (matches.length === 1) return { line: matches[0], status: "moved" };
  const byContext = matches.filter((line) => contextHash(lines, line - 1) === anchor.contextHash);
  if (byContext.length === 1) return { line: byContext[0], status: "moved" };
  return { line: null, status: "outdated" };
}
function nearest(candidates, target, window) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (distance <= window && distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// src/server/review/state.ts
import { mkdir, readFile as readFile3, rename, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
var STATE_FILE = "state.json";
function stateDirFor(gitDir2) {
  return join3(gitDir2, "web-review");
}
function emptyState() {
  return { version: 1, round: 0, threads: [] };
}
async function readState(stateDir) {
  let raw;
  try {
    raw = await readFile3(join3(stateDir, STATE_FILE), "utf8");
  } catch (error) {
    if (isENOENT(error)) return emptyState();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.threads)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}
async function writeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const target = join3(stateDir, STATE_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await rename(temp, target);
}
function nextId(threads) {
  const highest = threads.reduce((max, thread) => {
    const n = Number.parseInt(thread.id.slice(1), 10);
    return Number.isNaN(n) ? max : Math.max(max, n);
  }, 0);
  return `t${highest + 1}`;
}
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
async function openRound(state, request, lookup, now = nowIso) {
  const round = state.round + 1;
  const threads = [];
  for (const thread of state.threads) {
    const lines = await lookup(thread.file, thread.side);
    if (lines === null) {
      threads.push({ ...thread, status: thread.status === "open" ? "outdated" : thread.status });
      continue;
    }
    const moved = relocate(thread.anchor, lines);
    if (moved.line === null) {
      threads.push({ ...thread, status: thread.status === "open" ? "outdated" : thread.status });
      continue;
    }
    threads.push({
      ...thread,
      status: thread.status === "outdated" ? "open" : thread.status,
      anchor: {
        ...thread.anchor,
        line: moved.line,
        contextHash: contextHash(lines, moved.line - 1)
      }
    });
  }
  for (const reply of request.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) thread.messages = [...thread.messages, message("agent", round, reply.body, now)];
  }
  for (const annotation of request.annotations) {
    const lines = await lookup(annotation.file, annotation.side);
    if (!lines || lines[annotation.line - 1] === void 0) continue;
    threads.push({
      id: nextId(threads),
      file: annotation.file,
      side: annotation.side,
      anchor: makeAnchor(lines, annotation.line),
      status: "open",
      messages: [message("agent", round, annotation.body, now)]
    });
  }
  return { version: 1, round, threads };
}
async function applySubmission(state, payload, lookup, now = nowIso) {
  const threads = state.threads.map((thread) => ({ ...thread }));
  for (const reply of payload.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) {
      thread.messages = [...thread.messages, message("user", state.round, reply.body, now)];
    }
  }
  for (const id of payload.resolved) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = "resolved";
  }
  for (const id of payload.reopened) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = "open";
  }
  for (const comment of payload.newComments) {
    const lines = await lookup(comment.file, comment.side);
    if (!lines || lines[comment.line - 1] === void 0) continue;
    threads.push({
      id: nextId(threads),
      file: comment.file,
      side: comment.side,
      anchor: makeAnchor(lines, comment.line),
      status: "open",
      messages: [message("user", state.round, comment.body, now)]
    });
  }
  return { ...state, threads };
}
function message(author, round, body, now) {
  return { author, round, body, at: now() };
}

// src/server/review/result.ts
function submittedResult(state, verdict, general) {
  return {
    status: "submitted",
    verdict,
    round: state.round,
    general,
    threads: state.threads
  };
}
function pendingResult(url) {
  return { status: "pending", url };
}
function noChangesResult() {
  return { status: "no_changes" };
}
function abortedResult() {
  return { status: "aborted" };
}
function errorResult(message2) {
  return { status: "error", message: message2 };
}

// src/server/http/security.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
var TOKEN_HEADER = "x-review-token";
var LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];
function makeToken() {
  return randomBytes(16).toString("hex");
}
function isHostAllowed(host, port) {
  if (!host) return false;
  return LOOPBACK_HOSTS.some((allowed) => host === `${allowed}:${port}`);
}
function isTokenValid(provided, expected) {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// src/server/http/server.ts
import { createServer } from "node:http";
import { mkdir as mkdir2, readFile as readFile5, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join5 } from "node:path";

// src/server/http/routes.ts
var SubmissionConflictError = class extends Error {
};
var MAX_BODY_BYTES = 4 * 1024 * 1024;
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError("submission is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("submission is not valid JSON");
  }
}
async function handleApi(req, res, deps) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.port}`);
  if (!url.pathname.startsWith("/api/")) return false;
  if (!isHostAllowed(req.headers.host, deps.port)) {
    sendJson(res, 403, { error: "forbidden host" });
    return true;
  }
  const header = req.headers[TOKEN_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!isTokenValid(provided, deps.token)) {
    sendJson(res, 401, { error: "invalid token" });
    return true;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/session") {
      sendJson(res, 200, await deps.getSession());
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/file") {
      const path = url.searchParams.get("path");
      const side = url.searchParams.get("side");
      if (!path || side !== "old" && side !== "new") {
        sendJson(res, 400, { error: "path and side=old|new are required" });
        return true;
      }
      const content = await deps.getFile(path, side);
      if (content === null) {
        res.writeHead(204).end();
        return true;
      }
      sendJson(res, 200, { content });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/wait") {
      const seconds = Number(url.searchParams.get("timeout") ?? "30");
      const bounded = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 600) : 30;
      sendJson(res, 200, { submitted: await deps.waitForSubmission(bounded * 1e3) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/review") {
      const payload = validateSubmit(await readBody(req));
      await deps.submit(payload);
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: "unknown endpoint" });
    return true;
  } catch (error) {
    const message2 = error instanceof Error ? error.message : "unexpected error";
    const status = error instanceof RequestError ? 400 : error instanceof SubmissionConflictError ? 409 : 500;
    sendJson(res, status, { error: message2 });
    return true;
  }
}

// src/server/http/static.ts
import { readFile as readFile4, realpath } from "node:fs/promises";
import { extname, join as join4, normalize, resolve, sep } from "node:path";
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};
function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
function resolveStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const stripped = decoded.replace(/^[/\\]+/, "");
  const relative = normalize(stripped);
  const firstSegment = relative.split(/[/\\]/)[0];
  if (firstSegment === "..") {
    return null;
  }
  const full = resolve(root, relative);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}
async function verifyPathContainment(root, path) {
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    return realPath === realRoot || realPath.startsWith(realRoot + sep);
  } catch {
    return true;
  }
}
async function serveStatic(root, urlPath) {
  const path = resolveStaticPath(root, urlPath === "/" ? "/index.html" : urlPath);
  if (path === null) {
    return { status: 403, body: Buffer.from("forbidden"), contentType: "text/plain" };
  }
  const contained = await verifyPathContainment(root, path);
  if (!contained) {
    return { status: 403, body: Buffer.from("forbidden"), contentType: "text/plain" };
  }
  const body = await readFile4(path).catch(() => null);
  if (body) return { status: 200, body, contentType: contentTypeFor(path) };
  const shell = await readFile4(join4(root, "index.html")).catch(() => null);
  if (shell) {
    return { status: 200, body: shell, contentType: CONTENT_TYPES[".html"] };
  }
  return { status: 404, body: Buffer.from("not found"), contentType: "text/plain" };
}

// src/server/http/server.ts
var SERVER_FILE = "server.json";
async function startServer(options) {
  let submitted = false;
  let submitting = false;
  const waiters = /* @__PURE__ */ new Set();
  let port = options.port;
  const waitForSubmission = (timeoutMs) => new Promise((resolve2) => {
    if (submitted) return resolve2(true);
    const settle = (value) => {
      clearTimeout(timer);
      waiters.delete(settle);
      resolve2(value);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    waiters.add(settle);
  });
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const deps = {
          token: options.token,
          port,
          getSession: options.getSession,
          getFile: options.getFile,
          waitForSubmission,
          // This server is the single writer for its repository for the lifetime
          // of one review: server.json plus isServerAlive's liveness check are
          // what prevent a second server process from starting concurrently
          // against the same repository. Within this process, the
          // `submitted`/`submitting` guard below is what prevents a second
          // (sequential or concurrent) POST /api/review from re-applying a
          // submission to persisted state — no cross-process locking is needed
          // for either.
          submit: async (payload) => {
            if (submitted || submitting) {
              throw new SubmissionConflictError("a review has already been submitted");
            }
            submitting = true;
            try {
              await options.onSubmit(payload);
            } catch (error) {
              submitting = false;
              throw error;
            }
            submitting = false;
            submitted = true;
            for (const waiter of [...waiters]) waiter(true);
          }
        };
        if (await handleApi(req, res, deps)) return;
        const response = await serveStatic(
          options.staticRoot,
          new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname
        );
        res.writeHead(response.status, {
          "content-type": response.contentType,
          "content-length": response.body.length,
          "cache-control": "no-store"
        });
        res.end(response.body);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("internal server error");
      }
    })();
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve2);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/?t=${options.token}`;
  await writeServerRecord(options.stateDir, {
    pid: process.pid,
    port,
    token: options.token,
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  return {
    port,
    url,
    waitForSubmission,
    async close() {
      await removeServerRecord(options.stateDir);
      await new Promise((resolve2) => server.close(() => resolve2()));
    }
  };
}
async function writeServerRecord(stateDir, record) {
  await mkdir2(stateDir, { recursive: true });
  await writeFile2(join5(stateDir, SERVER_FILE), `${JSON.stringify(record, null, 2)}
`, "utf8");
}
async function readServerRecord(stateDir) {
  const raw = await readFile5(join5(stateDir, SERVER_FILE), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function removeServerRecord(stateDir) {
  await rm2(join5(stateDir, SERVER_FILE), { force: true });
}
async function isServerAlive(record) {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const response = await fetch(`http://127.0.0.1:${record.port}/api/session`, {
    headers: { "x-review-token": record.token }
  }).catch(() => null);
  return response?.ok === true;
}

// src/server/cli.ts
var RESULT_FILE = "result.json";
var SESSION_FILE = "session.json";
function parseArgs(argv) {
  const options = {
    base: "auto",
    timeoutSeconds: 540,
    port: 0,
    open: true,
    stop: false,
    serveInternal: false
  };
  const number = (raw, flag) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`web-review: ${flag} needs a number`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") options.base = argv[++i] ?? "auto";
    else if (arg === "--staged") options.base = "staged";
    else if (arg === "--timeout") options.timeoutSeconds = number(argv[++i], "--timeout");
    else if (arg === "--port") options.port = number(argv[++i], "--port");
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--stop") options.stop = true;
    else if (arg === "--__serve") options.serveInternal = true;
    else if (arg.startsWith("-")) throw new Error(`web-review: unknown option: ${arg}`);
    else options.base = arg;
  }
  return options;
}
function linesLookup(range, cwd) {
  return async (file, side) => {
    const content = await readSide(file, side, range, { cwd });
    return content === null ? null : splitLines(content);
  };
}
function emit(result, code = 0) {
  process.stdout.write(`${frameResult(result)}
`, () => process.exit(code));
}
function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
var moduleDir = fileURLToPath(new URL(".", import.meta.url));
async function serveMain(cwd, stateDir) {
  const session = JSON.parse(await readFile6(join6(stateDir, SESSION_FILE), "utf8"));
  const range = { base: session.base, label: session.label, staged: session.staged };
  const lookup = linesLookup(range, cwd);
  const handle = await startServer({
    staticRoot: join6(moduleDir, "..", "app", "dist"),
    stateDir,
    port: session.port,
    token: session.token,
    getSession: async () => {
      const state = await readState(stateDir);
      return {
        round: state.round,
        base: range.base,
        baseLabel: range.label,
        summary: session.summary,
        files: await listChangedFiles(range, { cwd }),
        threads: state.threads
      };
    },
    getFile: async (path, side) => readSide(path, side, range, { cwd }),
    onSubmit: async (payload) => {
      const state = await readState(stateDir);
      const next = await applySubmission(state, payload, lookup);
      await writeState(stateDir, next);
      await writeFile3(
        join6(stateDir, RESULT_FILE),
        JSON.stringify(submittedResult(next, payload.verdict, payload.general), null, 2),
        "utf8"
      );
    }
  });
  await handle.waitForSubmission(24 * 60 * 60 * 1e3);
  setTimeout(() => void handle.close().then(() => process.exit(0)), 250).unref();
}
async function waitForResult(stateDir, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  while (Date.now() < deadline) {
    const raw = await readFile6(join6(stateDir, RESULT_FILE), "utf8").catch(() => null);
    if (raw !== null) {
      await rm3(join6(stateDir, RESULT_FILE), { force: true });
      return JSON.parse(raw);
    }
    await new Promise((resolve2) => setTimeout(resolve2, 250));
  }
  return null;
}
var LOCK_FILE = "server.lock";
var LOCK_STALE_MS = 1e4;
function isEExist(error) {
  return typeof error === "object" && error !== null && error.code === "EEXIST";
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function acquireSpawnLock(stateDir) {
  const lockPath = join6(stateDir, LOCK_FILE);
  const mine = { pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() };
  try {
    await writeFile3(lockPath, JSON.stringify(mine), { flag: "wx" });
    return true;
  } catch (error) {
    if (!isEExist(error)) throw error;
  }
  const raw = await readFile6(lockPath, "utf8").catch(() => null);
  if (raw === null) {
    return acquireSpawnLock(stateDir);
  }
  let other;
  try {
    other = JSON.parse(raw);
  } catch {
    other = null;
  }
  const fresh = typeof other?.at === "string" && Date.now() - Date.parse(other.at) < LOCK_STALE_MS;
  const alive = typeof other?.pid === "number" && isPidAlive(other.pid);
  if (fresh && alive) return false;
  await rm3(lockPath, { force: true });
  return acquireSpawnLock(stateDir);
}
async function releaseSpawnLock(stateDir) {
  await rm3(join6(stateDir, LOCK_FILE), { force: true });
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const root = await repoRoot({ cwd }).catch(() => null);
  if (root === null) {
    emit(errorResult("not a git repository"), 1);
    return;
  }
  const gitDir2 = await gitDir({ cwd: root });
  const stateDir = stateDirFor(gitDir2);
  if (options.serveInternal) {
    await serveMain(root, stateDir);
    return;
  }
  if (options.stop) {
    const record = await readServerRecord(stateDir);
    const alive = record !== null && await isServerAlive(record);
    if (alive) {
      try {
        process.kill(record.pid);
      } catch {
      }
      await removeServerRecord(stateDir);
      emit({ ...abortedResult(), message: "server stopped" });
      return;
    }
    if (record) await removeServerRecord(stateDir);
    emit({ ...abortedResult(), message: "no server was running" });
    return;
  }
  const existing = await readServerRecord(stateDir);
  if (existing && await isServerAlive(existing)) {
    const result2 = await waitForResult(stateDir, options.timeoutSeconds);
    emit(result2 ?? pendingResult(`http://127.0.0.1:${existing.port}/?t=${existing.token}`));
    return;
  }
  await removeServerRecord(stateDir);
  const request = await consumeRequest(stateDir);
  const range = await resolveRange(options.base === "auto" ? request.base : options.base, { cwd: root });
  const files = await listChangedFiles(range, { cwd: root });
  if (files.length === 0) {
    emit(noChangesResult());
    return;
  }
  const state = await openRound(await readState(stateDir), request, linesLookup(range, root));
  await writeState(stateDir, state);
  await rm3(join6(stateDir, RESULT_FILE), { force: true });
  const token = makeToken();
  const session = {
    base: range.base,
    label: range.label,
    staged: range.staged,
    summary: request.summary,
    token,
    port: options.port
  };
  await writeFile3(join6(stateDir, SESSION_FILE), JSON.stringify(session, null, 2), "utf8");
  const shouldSpawn = await acquireSpawnLock(stateDir);
  let serverRecord;
  if (shouldSpawn) {
    try {
      spawn(process.execPath, [process.argv[1], "--__serve"], {
        cwd: root,
        detached: true,
        stdio: "ignore"
      }).unref();
      serverRecord = await waitForRecord(stateDir);
    } finally {
      await releaseSpawnLock(stateDir);
    }
  } else {
    serverRecord = await waitForRecord(stateDir);
  }
  if (!serverRecord) {
    emit(errorResult("the review server failed to start"), 1);
    return;
  }
  const url = `http://127.0.0.1:${serverRecord.port}/?t=${serverRecord.token}`;
  if (options.open) openBrowser(url);
  const result = await waitForResult(stateDir, options.timeoutSeconds);
  emit(result ?? pendingResult(url));
}
async function waitForRecord(stateDir) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await readServerRecord(stateDir);
    if (record) return record;
    await new Promise((resolve2) => setTimeout(resolve2, 50));
  }
  return null;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => emit(abortedResult(), 130));
  }
  main().catch((error) => {
    emit(errorResult(error instanceof Error ? error.message : "unexpected error"), 1);
  });
}
export {
  RESULT_FILE,
  SESSION_FILE,
  parseArgs
};
