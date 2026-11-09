import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

it('genera y verifica hashes PBKDF2 de 100 000 iteraciones', async () => {
  const password = 'contraseña de prueba';
  const hash = await hashPassword(password);

  expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  await expect(verifyPassword(password, hash)).resolves.toBe(true);
  await expect(verifyPassword('incorrecta', hash)).resolves.toBe(false);
});

it('acepta un hash de 100 000 iteraciones y rechaza uno de 600 000', async () => {
  const password = 'solo-prueba-local';
  const supported = 'pbkdf2-sha256$100000$01010101010101010101010101010101$1dc845a7b41b3d862fab1c698cd92df3378dd528f61379737cfff14f41ba5baf';
  const unsupported = 'pbkdf2-sha256$600000$01010101010101010101010101010101$f2b600deda0736be4e4c7f023b6610ddcb3ab2bf04ac717d89151d4f3a794d9f';

  await expect(verifyPassword(password, supported)).resolves.toBe(true);
  await expect(verifyPassword(password, unsupported)).resolves.toBe(false);
});
