import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-review-token';
export const TOKEN_QUERY = 't';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export function makeToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Without this check any website open in the same browser could resolve its own
 * domain to 127.0.0.1 and read this repository through our own API.
 */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.some((allowed) => host === `${allowed}:${port}`);
}

export function isTokenValid(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided) return false;

  // Build both buffers first to avoid throwing on byte-length mismatch
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  // Compare byte lengths before calling timingSafeEqual
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
