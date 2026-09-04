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
});

describe('isTokenValid', () => {
  const token = makeToken();

  it('accepts the exact token', () => {
    expect(isTokenValid(token, token)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(isTokenValid(`${token.slice(0, -1)}0`, token)).toBe(false);
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
