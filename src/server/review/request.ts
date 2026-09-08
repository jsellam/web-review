import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MessageRef,
  Reply,
  ReviewRequest,
  Side,
  SubmitPayload,
  Verdict,
} from '../../shared/types.js';

export const REQUEST_FILE = 'request.json';

export class RequestError extends Error {
  constructor(message: string) {
    super(`web-review: ${message}`);
    this.name = 'RequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isENOENT(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function asString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new RequestError(`${field} must be a string`);
  return value;
}

function asSide(value: unknown, field: string): Side {
  if (value !== 'old' && value !== 'new') {
    throw new RequestError(`${field} must be "old" or "new"`);
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequestError(`${field} must be an array`);
  return value;
}

/**
 * `Annotation` (request.json) and `NewComment` (a submission) are the same four
 * fields — file, line, side, body — differing only in which list they live in.
 * One parameterised parser covers both instead of duplicating the field logic.
 */
function toLineComment(listField: string) {
  return (raw: unknown, index: number): { file: string; line: number; side: Side; body: string } => {
    const field = `${listField}[${index}]`;
    if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

    const line = raw['line'];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw new RequestError(`${field}.line must be an integer >= 1`);
    }

    return {
      file: asString(raw['file'], `${field}.file`),
      line,
      side: asSide(raw['side'], `${field}.side`),
      body: asString(raw['body'], `${field}.body`),
    };
  };
}

function toReply(raw: unknown, index: number): Reply {
  const field = `replies[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

  return {
    threadId: asString(raw['threadId'], `${field}.threadId`),
    body: asString(raw['body'], `${field}.body`),
  };
}

/** Validate a parsed request.json. Every field is optional; every error names its field. */
export function validateRequest(raw: unknown): ReviewRequest {
  if (!isRecord(raw)) throw new RequestError('request.json must be a JSON object');

  return {
    summary: asString(raw['summary'], 'summary', ''),
    base: asString(raw['base'], 'base', 'auto'),
    annotations: asArray(raw['annotations'], 'annotations').map(toLineComment('annotations')),
    replies: asArray(raw['replies'], 'replies').map(toReply),
  };
}

function defaults(): ReviewRequest {
  return { summary: '', base: 'auto', annotations: [], replies: [] };
}

export async function readRequest(stateDir: string): Promise<ReviewRequest> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, REQUEST_FILE), 'utf8');
  } catch (error) {
    if (isENOENT(error)) return defaults();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestError('request.json is not valid JSON');
  }
  return validateRequest(parsed);
}

/** Read then delete, so a request from a previous round never reappears. */
export async function consumeRequest(stateDir: string): Promise<ReviewRequest> {
  const request = await readRequest(stateDir);
  await rm(join(stateDir, REQUEST_FILE), { force: true });
  return request;
}

const VERDICTS: Verdict[] = ['approve', 'request_changes', 'comment'];

function asVerdict(value: unknown): Verdict {
  if (typeof value !== 'string' || !VERDICTS.includes(value as Verdict)) {
    throw new RequestError(`verdict must be one of: ${VERDICTS.join(', ')}`);
  }
  return value as Verdict;
}

function toMessageRef(raw: unknown, index: number): MessageRef {
  const field = `deletions[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

  const at = raw['index'];
  if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) {
    throw new RequestError(`${field}.index must be an integer >= 0`);
  }

  return { threadId: asString(raw['threadId'], `${field}.threadId`), index: at };
}

function asIdList(value: unknown, field: string): string[] {
  return asArray(value, field).map((id, index) => {
    if (typeof id !== 'string') throw new RequestError(`${field}[${index}] must be a string`);
    return id;
  });
}

/** Validate what the browser POSTs. Same shape of errors as validateRequest. */
export function validateSubmit(raw: unknown): SubmitPayload {
  if (!isRecord(raw)) throw new RequestError('submission must be a JSON object');

  return {
    verdict: asVerdict(raw['verdict']),
    general: asString(raw['general'], 'general', ''),
    newComments: asArray(raw['newComments'], 'newComments').map(toLineComment('newComments')),
    replies: asArray(raw['replies'], 'replies').map(toReply),
    resolved: asIdList(raw['resolved'], 'resolved'),
    reopened: asIdList(raw['reopened'], 'reopened'),
    deletions: asArray(raw['deletions'], 'deletions').map(toMessageRef),
  };
}
