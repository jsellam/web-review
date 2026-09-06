import { describe, expect, it } from 'vitest';
import { isHostAllowed, isTokenValid, makeToken } from './security.js';

describe('makeToken', () => {
  it('returns 32 hex characters', () => {
    expect(makeToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat itself', () => {
    expect(makeToken()).not.toBe(makeToken());
  });
});

describe('isHostAllowed', () => {
  it('accepts loopback hosts on the right port', () => {
    expect(isHostAllowed('127.0.0.1:4711', 4711)).toBe(true);
    expect(isHostAllowed('localhost:4711', 4711)).toBe(true);
  });

  it('rejects a loopback host on a different port', () => {
    expect(isHostAllowed('127.0.0.1:80', 4711)).toBe(false);
  });

  it('rejects any other host, which is what stops DNS rebinding', () => {
    expect(isHostAllowed('evil.example.com:4711', 4711)).toBe(false);
    expect(isHostAllowed('192.168.1.10:4711', 4711)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isHostAllowed(undefined, 4711)).toBe(false);
  });

  it('rejects a trailing-dot host (DNS rebinding variant)', () => {
    expect(isHostAllowed('127.0.0.1.:4711', 4711)).toBe(false);
    expect(isHostAllowed('localhost.:4711', 4711)).toBe(false);
  });

  it('rejects a different-case host', () => {
    expect(isHostAllowed('LOCALHOST:4711', 4711)).toBe(false);
    expect(isHostAllowed('127.0.0.1:4711', 4711)).toBe(true); // lowercase still works
  });
});

describe('isTokenValid', () => {
  const token = makeToken();

  it('accepts the exact token', () => {
    expect(isTokenValid(token, token)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    // Flipping the last hex digit to a value it provably is not (rather than
    // a fixed literal like '0') keeps the "wrong" token guaranteed different
    // from the real one: makeToken() returns random hex, so a fixed literal
    // collides with the real token whenever it happens to end in that digit,
    // making this a 1-in-16 flake.
    const lastDigit = token.slice(-1);
    const differentDigit = lastDigit === '0' ? '1' : '0';
    const wrongToken = `${token.slice(0, -1)}${differentDigit}`;
    expect(wrongToken).not.toBe(token);

    expect(isTokenValid(wrongToken, token)).toBe(false);
  });

  it('demonstrates the flake the old "append a fixed digit" approach had', () => {
    // This is the failure mode fixed above, made deterministic instead of
    // 1-in-16: the old test built its "wrong" token as
    // `${token.slice(0, -1)}0`. Whenever the real token already ends in '0'
    // (as this one does, by construction), that expression reconstructs the
    // exact same token, so isTokenValid correctly says it's valid — and the
    // old test's `expect(...).toBe(false)` would fail.
    const tokenEndingInZero = `${'a'.repeat(31)}0`;
    const oldNaiveWrongToken = `${tokenEndingInZero.slice(0, -1)}0`;
    expect(isTokenValid(oldNaiveWrongToken, tokenEndingInZero)).toBe(true);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(isTokenValid('short', token)).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(isTokenValid(null, token)).toBe(false);
    expect(isTokenValid(undefined, token)).toBe(false);
  });

  it('rejects a same-string-length different-byte-length token without throwing', () => {
    // 'é' is 1 character but 2 bytes in UTF-8
    // 32 'é' characters = 32 string length but 64 byte length
    const multibyteToken = 'é'.repeat(32);
    expect(multibyteToken.length).toBe(32); // same string length
    expect(Buffer.from(multibyteToken).length).toBe(64); // different byte length
    expect(isTokenValid(multibyteToken, token)).toBe(false);
  });
});
