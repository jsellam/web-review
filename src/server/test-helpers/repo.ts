import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestRepo {
  dir: string;
  write(path: string, content: string): Promise<void>;
  run(...args: string[]): Promise<string>;
  commit(message: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'web-review-'));

  const git = async (...args: string[]) => {
    const { stdout } = await run('git', args, { cwd: dir });
    return stdout;
  };

  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');

  return {
    dir,
    run: git,
    async write(path, content) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    },
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-m', message);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
