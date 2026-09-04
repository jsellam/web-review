import { readFile, realpath } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Returns null when the requested path would escape the served root. */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  // Strip leading slashes first, then normalize.
  // This allows us to detect traversal attempts like /../../etc/passwd
  // which become ../../etc/passwd after stripping, revealing the traversal.
  const stripped = decoded.replace(/^[/\\]+/, '');
  const relative = normalize(stripped);

  // Reject paths that try to escape the root with .. as the first segment.
  // Use segment-aware check: split by separators and check first segment only.
  const firstSegment = relative.split(/[/\\]/)[0];
  if (firstSegment === '..') {
    return null;
  }

  const full = resolve(root, relative);
  const rootResolved = resolve(root);

  // Final verification: ensure the resolved path is within the root
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

/**
 * Verifies that a syntactically valid path is also actually contained within the root,
 * following symlinks. Rejects symlinks that escape the root.
 */
export async function verifyPathContainment(root: string, path: string): Promise<boolean> {
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    return realPath === realRoot || realPath.startsWith(realRoot + sep);
  } catch {
    // realpath throws ENOENT if the path doesn't exist.
    // That is not a containment failure; it is simply a missing file.
    return true;
  }
}

export interface StaticResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

export async function serveStatic(root: string, urlPath: string): Promise<StaticResponse> {
  const path = resolveStaticPath(root, urlPath === '/' ? '/index.html' : urlPath);
  if (path === null) {
    return { status: 403, body: Buffer.from('forbidden'), contentType: 'text/plain' };
  }

  // Check that symlinks don't escape the root
  const contained = await verifyPathContainment(root, path);
  if (!contained) {
    return { status: 403, body: Buffer.from('forbidden'), contentType: 'text/plain' };
  }

  const body = await readFile(path).catch(() => null);
  if (body) return { status: 200, body, contentType: contentTypeFor(path) };

  // Unknown route: hand back the SPA shell so a browser reload still works.
  const shell = await readFile(join(root, 'index.html')).catch(() => null);
  if (shell) {
    return { status: 200, body: shell, contentType: CONTENT_TYPES['.html']! };
  }

  return { status: 404, body: Buffer.from('not found'), contentType: 'text/plain' };
}
