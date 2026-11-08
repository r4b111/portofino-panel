import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, toBase64Url } from './crypto';

const secret = 'secreto de prueba';

describe('AES-256-GCM', () => {
  it.each(['', '\uFEFFPedido de café ☕'])('recupera el texto original %j', async (plaintext) => {
    const envelope = await encrypt(plaintext, secret);
    await expect(decrypt(envelope, secret)).resolves.toBe(plaintext);
  });

  it('usa un IV de 12 bytes distinto en cada llamada', async () => {
    const [first, second] = await Promise.all([
      encrypt('mismo mensaje', secret),
      encrypt('mismo mensaje', secret),
    ]);
    const firstIv = first.slice(0, first.indexOf('.'));
    const secondIv = second.slice(0, second.indexOf('.'));
    expect(firstIv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(secondIv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(firstIv).not.toBe(secondIv);
  });

  it('rechaza ciphertext corrupto aunque el formato siga siendo válido', async () => {
    const envelope = await encrypt('pedido', secret);
    const firstCipherChar = envelope.indexOf('.') + 1;
    const replacement = envelope[firstCipherChar] === 'A' ? 'B' : 'A';
    const corrupted = envelope.slice(0, firstCipherChar) + replacement +
      envelope.slice(firstCipherChar + 1);
    await expect(decrypt(corrupted, secret)).rejects.toMatchObject({ name: 'OperationError' });
  });

  it('rechaza el secreto incorrecto', async () => {
    const envelope = await encrypt('pedido', secret);
    await expect(decrypt(envelope, 'otro secreto')).rejects.toMatchObject({ name: 'OperationError' });
  });

  it('rechaza secretos en blanco', async () => {
    await expect(encrypt('pedido', '  ')).rejects.toThrow('DATA_SECRET es obligatorio');
  });

  it.each(['.AA', 'AA', 'AA.AA.AA'])('rechaza el sobre incompleto o inválido %s', async (envelope) => {
    await expect(decrypt(envelope, secret)).rejects.toThrow('Texto cifrado inválido');
  });

  it.each(['*.AA', 'A.AA', 'AB.AA'])('rechaza el base64url inválido %s', async (envelope) => {
    await expect(decrypt(envelope, secret)).rejects.toThrow('Base64url inválido');
  });

  it('rechaza un IV con una longitud incorrecta', async () => {
    const ciphertext = toBase64Url(new Uint8Array(16));
    await expect(decrypt('AA.' + ciphertext, secret)).rejects.toThrow('Texto cifrado inválido');
  });

  it('rechaza un ciphertext demasiado corto para incluir la etiqueta', async () => {
    const iv = toBase64Url(new Uint8Array(12));
    await expect(decrypt(iv + '.AA', secret)).rejects.toThrow('Texto cifrado inválido');
  });
});
