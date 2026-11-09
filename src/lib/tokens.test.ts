import { describe, expect, it } from 'vitest';
import { generateTrackingToken, hashTrackingToken } from './tokens';

describe('tokens de seguimiento', () => {
  it('genera tokens distintos de 32 bytes en base64url sin relleno', () => {
    const first = generateTrackingToken();
    const second = generateTrackingToken();
    for (const token of [first, second]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(atob(token.replaceAll('-', '+').replaceAll('_', '/') + '=')).toHaveLength(32);
    }
    expect(first).not.toBe(second);
  });

  it('produce un SHA-256 determinista de 64 caracteres hexadecimales', async () => {
    const hash = await hashTrackingToken('abc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await expect(hashTrackingToken('abc')).resolves.toBe(hash);
    await expect(hashTrackingToken('abcd')).resolves.not.toBe(hash);
  });
});
