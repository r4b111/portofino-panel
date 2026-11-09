# Portofino Orders

Andamiaje de Cloudflare Workers con Hono, D1, Drizzle, Zod y Vitest. El SQL inicial es la fuente de verdad para la migración. Los importes en COP se guardan en pesos enteros y las marcas de tiempo, en milisegundos Unix.

## Desarrollo local

Requiere Node.js 22.12 o posterior.

```sh
npm install --no-package-lock
npm run typecheck
npm test
npm run db:local
npm run dev
```

Wrangler crea la base local en `.wrangler/`. El identificador de base configurado es para desarrollo local. Para probar autenticación, copia `.dev.vars.example` a `.dev.vars` y genera un valor aleatorio e independiente para cada variable. Guarda las claves fuera de Git.

- `GET /health` comprueba que el Worker responde.
- `GET /orders/tracking` recibe el token en `X-Tracking-Token` y devuelve estado y datos de envío sin información personal.
- `GET /admin/orders/:number` recibe `Authorization: Bearer <ADMIN_TOKEN>` y consulta el estado y los importes del pedido.

Los pedidos de prueba deben cargarse por separado en D1. El andamiaje ofrece consultas de solo lectura. Las pruebas de cifrado y tokens se ejecutan en el pool de Cloudflare Workers con `npm test`. Para ejecutar solo esas suites, usa `npm test -- src/lib/crypto.test.ts src/lib/tokens.test.ts`.

## Criptografía

`encrypt` y `decrypt` usan AES-256-GCM con una clave derivada mediante SHA-256 del secreto. Cada cifrado usa un IV aleatorio de 12 bytes. El formato es `iv.ciphertext` en base64url sin relleno, con la etiqueta de autenticación incluida en el segundo componente. Usa un secreto aleatorio de alta entropía.

`generateTrackingToken` produce 32 bytes aleatorios en base64url. Entrega el valor original al cliente y guarda únicamente el SHA-256 hexadecimal devuelto por `hashTrackingToken`.
