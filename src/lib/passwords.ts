// workerd limita PBKDF2 de WebCrypto a 100 000 iteraciones: https://github.com/cloudflare/workerd/issues/1346
const iterations = 100_000;
const encoder = new TextEncoder();

async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, key, 256);
  return new Uint8Array(bits);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derive(password, salt);
  return ['pbkdf2-sha256', iterations, hex(salt), hex(digest)].join('$');
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const match = /^pbkdf2-sha256\$100000\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(stored ?? '');
  const salt = unhex(match?.[1] ?? '0'.repeat(32));
  const expected = unhex(match?.[2] ?? '0'.repeat(64));
  const digest = await derive(password, salt);
  // Both digests always have 32 bytes. Visit every byte before deciding.
  let difference = 0;
  for (let i = 0; i < digest.length; i++) {
    difference |= digest[i]! ^ expected[i]!;
  }
  return difference === 0 && match !== null;
}
