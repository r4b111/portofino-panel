# Portofino Orders

Andamiaje de Cloudflare Workers con Hono, D1, Drizzle, Zod y Vitest. El SQL inicial es la fuente de verdad para la migración. Los importes en COP se guardan en pesos enteros y las marcas de tiempo, en milisegundos Unix.

## Desarrollo local

Requiere Node.js 22.12 o posterior.

```sh
npm install --no-package-lock
npm run typecheck
npm run db:local
npm run dev
```

Wrangler crea la base local en `.wrangler/`. El identificador de base configurado es para desarrollo local. Para probar autenticación, copia `.dev.vars.example` a `.dev.vars` y genera un valor aleatorio e independiente para cada variable. Guarda las claves fuera de Git.

- `GET /health` comprueba que el Worker responde.
- `GET /orders/tracking` recibe el token en `X-Tracking-Token` y devuelve estado y datos de envío sin información personal.
- `GET /admin/orders/:number` consulta el estado y los importes del pedido con una sesión administrativa.

Los pedidos de prueba deben cargarse por separado en D1. El andamiaje ofrece consultas de solo lectura. Vitest queda configurado y el árbol solicitado no incluye archivos de prueba.

## Criptografía

`encrypt` y `decrypt` usan AES-256-GCM con una clave derivada mediante SHA-256 del secreto. Cada cifrado usa un IV aleatorio de 12 bytes. El formato es `iv.ciphertext` en base64url sin relleno, con la etiqueta de autenticación incluida en el segundo componente. Usa un secreto aleatorio de alta entropía.

`generateTrackingToken` produce 32 bytes aleatorios en base64url. Entrega el valor original al cliente y guarda únicamente el SHA-256 hexadecimal devuelto por `hashTrackingToken`.

## Acceso administrativo

Configura `ADMIN_SESSION_SECRET` con al menos 32 caracteres aleatorios e independientes de `DATA_SECRET`. Aprovisiona los administradores en D1 con un correo en minúsculas, un rol `owner` o `agent` y el resultado de `hashPassword` de `src/lib/passwords.ts` en `password_hash`. La función usa PBKDF2-SHA-256 con sal aleatoria. Deja `totp_secret` en NULL para cuentas con contraseña. Las cuentas con un secreto TOTP configurado quedan bloqueadas hasta que se implemente la verificación de segundo factor.

Envía `{ "email": "...", "password": "..." }` como JSON a `POST /admin/login`. La sesión se entrega en una cookie firmada `__Host-admin_session` con `HttpOnly`, `Secure` y `SameSite=Strict`. Vence a las ocho horas. El servidor consulta el rol vigente al autenticar cada solicitud.

`PATCH /admin/orders/:number/status` recibe `{ "status": "..." }`. El mapa de transiciones está en `src/lib/orders/state.ts`. La cancelación exige el rol `owner`. Cada cambio válido y su registro en `audit_log` se guardan juntos y el cambio de versión protege contra escrituras concurrentes.
