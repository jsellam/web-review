import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentTypeFor, resolveStaticPath, serveStatic } from './static.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-review-static-'));
  await writeFile(join(root, 'index.html'), '<html>app</html>', 'utf8');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveStaticPath', () => {
  it('resolves a normal path inside the root', () => {
    expect(resolveStaticPath('/srv/app', '/assets/app.js')).toBe(join('/srv/app', 'assets/app.js'));
  });

  it('refuses to escape the root', () => {
    expect(resolveStaticPath('/srv/app', '/../../etc/passwd')).toBeNull();
    expect(resolveStaticPath('/srv/app', '/assets/../../etc/passwd')).toBeNull();
  });

  it('decodes percent-encoded traversal too', () => {
    expect(resolveStaticPath('/srv/app', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('maps the types the bundle actually emits', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('app.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
  });

  it('falls back to a safe default', () => {
    expect(contentTypeFor('unknown.xyz')).toBe('application/octet-stream');
  });
});

describe('serveStatic', () => {
  it('serves a real asset', async () => {
    const response = await serveStatic(root, '/assets/app.js');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('console.log(1)');
    expect(response.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('serves index.html at the root', async () => {
    expect((await serveStatic(root, '/')).body.toString()).toBe('<html>app</html>');
  });

  it('falls back to index.html for an unknown route, so reloads work', async () => {
    const response = await serveStatic(root, '/some/deep/route');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('<html>app</html>');
  });

  it('returns 403 for a traversal attempt', async () => {
    expect((await serveStatic(root, '/../secret')).status).toBe(403);
  });
});
