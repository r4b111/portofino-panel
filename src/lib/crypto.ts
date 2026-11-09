const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Base64url inválido');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new Error('Base64url inválido');
  return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret.trim()) throw new Error('DATA_SECRET es obligatorio');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, encoder.encode(plaintext),
  );
  return toBase64Url(iv) + '.' + toBase64Url(new Uint8Array(ciphertext));
}

export async function decrypt(envelope: string, secret: string): Promise<string> {
  const [encodedIv, encodedCiphertext, extra] = envelope.split('.');
  if (!encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new Error('Texto cifrado inválido');
  }
  const iv = fromBase64Url(encodedIv);
  const ciphertext = fromBase64Url(encodedCiphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Texto cifrado inválido');
  const key = await deriveKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext,
  );
  return decoder.decode(plaintext);
}
