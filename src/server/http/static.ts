import { readFile } from 'node:fs/promises';
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

  // Reject paths that try to escape the root with ..
  if (relative.startsWith('..')) {
    return null;
  }

  const full = resolve(root, relative);
  const rootResolved = resolve(root);

  // Final verification: ensure the resolved path is within the root
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
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

  const body = await readFile(path).catch(() => null);
  if (body) return { status: 200, body, contentType: contentTypeFor(path) };

  // Unknown route: hand back the SPA shell so a browser reload still works.
  const shell = await readFile(join(root, 'index.html')).catch(() => null);
  if (shell) {
    return { status: 200, body: shell, contentType: CONTENT_TYPES['.html']! };
  }

  return { status: 404, body: Buffer.from('not found'), contentType: 'text/plain' };
}
