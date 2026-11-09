const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stepMs = 30_000;

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> | null {
  const encoded = secret.replace(/\s/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(encoded) || [1, 3, 6].includes(encoded.length % 8)) return null;
  const bytes = new Uint8Array(Math.floor(encoded.length * 5 / 8));
  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const char of encoded) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = buffer >> bits;
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? bytes : null;
}

export async function matchingTotpStep(secret: string, code: string | undefined, now: number) {
  if (!code || !/^\d{6}$/.test(code)) return null;
  const bytes = decodeSecret(secret);
  if (!bytes) return null;
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const step = Math.floor(now / stepMs);
  const candidates = await Promise.all([step - 1, step, step + 1].map(async (candidate) => {
    if (candidate < 0) return null;
    const counter = new DataView(new ArrayBuffer(8));
    counter.setBigUint64(0, BigInt(candidate));
    const mac = new DataView(await crypto.subtle.sign('HMAC', key, counter));
    const offset = mac.getUint8(mac.byteLength - 1) & 0x0f;
    const expected = (mac.getUint32(offset) & 0x7fffffff) % 1_000_000;
    return expected === Number(code) ? candidate : null;
  }));
  return candidates[2] ?? candidates[1] ?? candidates[0] ?? null;
}
