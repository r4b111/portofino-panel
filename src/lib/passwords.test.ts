import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

it('genera y verifica hashes PBKDF2 de 600 000 iteraciones', async () => {
  const password = 'contraseña de prueba';
  const hash = await hashPassword(password);

  expect(hash).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  await expect(verifyPassword(password, hash)).resolves.toBe(true);
  await expect(verifyPassword('incorrecta', hash)).resolves.toBe(false);
});
