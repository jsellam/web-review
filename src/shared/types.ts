export type Side = 'old' | 'new';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type ThreadStatus = 'open' | 'resolved' | 'outdated';
export type Author = 'user' | 'agent';
export type Verdict = 'approve' | 'request_changes' | 'comment';
export type ResultStatus =
  | 'submitted' | 'pending' | 'no_changes' | 'aborted' | 'error';

/** One changed file. `path` is the new path, or the old path for deletions. */
export interface FileEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Where a thread is pinned. `content` and `contextHash` let us find it again after edits. */
export interface Anchor {
  line: number;
  content: string;
  contextHash: string;
}

export interface Message {
  author: Author;
  round: number;
  body: string;
  at: string;
}

export interface Thread {
  id: string;
  file: string;
  side: Side;
  anchor: Anchor;
  status: ThreadStatus;
  messages: Message[];
}

export interface ReviewState {
  version: 1;
  round: number;
  threads: Thread[];
}

/** An inline note the agent leaves before the review opens. */
export interface Annotation {
  file: string;
  line: number;
  side: Side;
  body: string;
}

export interface Reply {
  threadId: string;
  body: string;
}

/** `.git/web-review/request.json`, written by the agent. All fields optional on disk. */
export interface ReviewRequest {
  summary: string;
  base: string;
  annotations: Annotation[];
  replies: Reply[];
}

export interface SessionPayload {
  round: number;
  base: string;
  baseLabel: string;
  summary: string;
  files: FileEntry[];
  threads: Thread[];
}

export interface NewComment {
  file: string;
  side: Side;
  line: number;
  body: string;
}

/**
 * What the browser POSTs. The client never computes anchors — it sends line
 * numbers, and the server anchors them, because only the server has file contents.
 */
export interface SubmitPayload {
  verdict: Verdict;
  general: string;
  newComments: NewComment[];
  replies: Reply[];
  resolved: string[];
  reopened: string[];
}

export interface CliResult {
  status: ResultStatus;
  verdict?: Verdict;
  round?: number;
  general?: string;
  threads?: Thread[];
  url?: string;
  message?: string;
  /** New comments that could not be anchored to a line and were dropped from `threads`. */
  unanchored?: NewComment[];
}
