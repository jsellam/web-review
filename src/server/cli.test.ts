import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

const defaults = {
  base: 'auto',
  timeoutSeconds: 540,
  port: 0,
  open: true,
  stop: false,
  serveInternal: false,
  prepare: false,
};

describe('parseArgs', () => {
  it('defaults to auto base, a 540s timeout and an OS-assigned port', () => {
    expect(parseArgs([])).toEqual(defaults);
  });

  it('takes a bare ref as the base', () => {
    expect(parseArgs(['HEAD~3'])).toEqual({ ...defaults, base: 'HEAD~3' });
  });

  it('accepts --base, --timeout and --port', () => {
    expect(parseArgs(['--base', 'main', '--timeout', '30', '--port', '4711'])).toEqual({
      ...defaults,
      base: 'main',
      timeoutSeconds: 30,
      port: 4711,
    });
  });

  it('accepts --staged as a shorthand for --base staged', () => {
    expect(parseArgs(['--staged'])).toEqual({ ...defaults, base: 'staged' });
  });

  it('turns off the browser with --no-open', () => {
    expect(parseArgs(['--no-open'])).toEqual({ ...defaults, open: false });
  });

  it('recognises --stop', () => {
    expect(parseArgs(['--stop'])).toEqual({ ...defaults, stop: true });
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown option: --wat/);
  });

  it('recognises --prepare', () => {
    expect(parseArgs(['--prepare'])).toEqual({ ...defaults, prepare: true });
  });

  it('combines --prepare with a base', () => {
    expect(parseArgs(['--prepare', '--staged'])).toEqual({
      ...defaults,
      prepare: true,
      base: 'staged',
    });
  });
});
