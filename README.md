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
- `GET /admin/orders/:number` consulta el estado y los importes del pedido con una sesión administrativa.

Ejecuta `npm test` para correr las pruebas en el pool de Cloudflare Workers. Para ejecutar solo las suites de cifrado y tokens, usa `npm test -- src/lib/crypto.test.ts src/lib/tokens.test.ts`.

## Criptografía

`encrypt` y `decrypt` usan AES-256-GCM con una clave derivada mediante SHA-256 del secreto. Cada cifrado usa un IV aleatorio de 12 bytes. El formato es `iv.ciphertext` en base64url sin relleno, con la etiqueta de autenticación incluida en el segundo componente. Usa un secreto aleatorio de alta entropía.

`generateTrackingToken` produce 32 bytes aleatorios en base64url. Entrega el valor original al cliente y guarda únicamente el SHA-256 hexadecimal devuelto por `hashTrackingToken`.

## Acceso administrativo

Configura `ADMIN_SESSION_SECRET` con al menos 32 caracteres aleatorios e independientes de `DATA_SECRET`. Aprovisiona los administradores en D1 con un correo en minúsculas, un rol `owner` o `agent` y el resultado de `hashPassword` de `src/lib/passwords.ts` en `password_hash`. La función usa PBKDF2-SHA-256 con sal aleatoria. Deja `totp_secret` en NULL para cuentas con contraseña. Las cuentas con un secreto TOTP configurado quedan bloqueadas hasta que se implemente la verificación de segundo factor.

Envía `{ "email": "...", "password": "..." }` como JSON a `POST /admin/login`. La sesión se entrega en una cookie firmada `__Host-admin_session` con `HttpOnly`, `Secure` y `SameSite=Strict`. Vence a las ocho horas. El servidor consulta el rol vigente al autenticar cada solicitud.

`PATCH /admin/orders/:number/status` recibe `{ "status": "...", "expectedVersion": 1 }`. El mapa de transiciones está en `src/lib/orders/state.ts`. La cancelación exige el rol `owner`. Cada cambio válido y su registro en `audit_log` se guardan juntos y el cambio de versión protege contra escrituras concurrentes.

## Panel de pedidos

Entra en `/login` con una cuenta administrativa de D1. El panel renderiza HTML en español con Hono JSX. `/pedidos` lista hasta 50 pedidos por página y admite `estado` y `pagina` como parámetros. `/pedidos/:id` usa el identificador interno del pedido y muestra sus ítems, eventos y cambios de estado auditados.

Los botones envían el nuevo estado y la versión del formulario. Si otro agente ya actualizó el pedido, el servidor devuelve HTTP 409, muestra «Otro agente lo modificó» y conserva los valores enviados. El formulario queda disponible para consulta y el enlace de recarga permite revisar la versión vigente antes de decidir otra transición.

## Conversación en tiempo real

Cada pedido tiene un Durable Object con almacenamiento SQLite. En local, Wrangler aplica su migración de clase al iniciar el Worker. El panel conecta desde `/pedidos/:id`. El cliente abre `/seguimiento` con su código de seguimiento o mediante un enlace privado `/seguimiento#token=<código>`. Al reabrir ese enlace o la página del panel, se recuperan los mensajes guardados.

El cliente solicita un ticket con `POST /api/orders/realtime-token` y `X-Tracking-Token`. El panel usa `POST /api/pedidos/:id/realtime-token` con su cookie. El ticket dura hasta cinco minutos, se consume una vez y se limita por el vencimiento del acceso al pedido o de la sesión. Se pasa a `GET /api/orders/:id/realtime?after=0` mediante los subprotocolos `portofino.v1` y `ticket.<token>`. El servidor negocia `portofino.v1`.

Para enviar texto, usa `{ "type": "message", "id": "<UUID>", "body": "..." }`. Un reintento usa el mismo UUID. El servidor confirma duplicados con `ack` y difunde cada mensaje nuevo una sola vez. Las conexiones nuevas reciben `status`, el historial posterior a `after` y luego `ready`. El navegador conserva el cursor mientras la página está abierta y reconstruye el historial al recargarla. D1 conserva la versión de estado de referencia, que se consulta al reconectar.

## Telegram

Aplica la migración `0003_telegram.sql` y configura `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` como secretos del Worker. Registra `https://<worker>/webhooks/telegram` mediante `setWebhook` de la API de Telegram, usando el mismo valor en `secret_token` y suscribiendo el tipo de actualización `message`.

El cliente vincula su pedido en un chat privado con el bot mediante `/start <token-de-seguimiento>`. Cada chat o tema queda asociado a un solo pedido. Los mensajes de texto recibidos aparecen en la conversación del panel. Las respuestas escritas por un agente en el panel se envían a Telegram cuando hay un chat vinculado y el bot está configurado.

La cola persiste en el Durable Object del pedido. Tras el intento inicial, reintenta a los 1, 2 y 4 segundos. Telegram no ofrece una clave de idempotencia para `sendMessage`. Si acepta un envío y se pierde la respuesta antes de que el Worker registre su ID, un reintento podría generar una segunda entrega.


El cliente puede enviar mensajes con `POST /api/orders/messages`, el encabezado `X-Tracking-Token` y un cuerpo `{ "id": "<UUID>", "body": "..." }`. Se aceptan hasta 2000 caracteres y diez mensajes por código de seguimiento durante una ventana de un minuto. El límite se comparte con WebSocket. HTTP devuelve `429` y `Retry-After` en segundos. En WebSocket, el aviso equivalente lleva el tipo `rate_limited`.


## Alta de pedidos

`POST /api/orders` recibe `name`, `email`, `phone`, `address`, `city` opcional y entre 1 y 20 ítems. Cada ítem requiere `productId`, `qty` de 1 a 99 y `unitAmount` entero no negativo. Configura `DATA_SECRET` y carga los productos en `order_catalog` después de aplicar `0006_order_catalog.sql`. El servidor calcula los importes con el precio registrado en el catálogo.

La respuesta `201` entrega `{ number, token, expiresAt }`. Guarda el token en el cliente al recibirlo. El pedido pendiente vence a las 72 horas. Si se confirma, se elimina ese vencimiento y el código de seguimiento sigue funcionando.


## Retención de pedidos

Al confirmar se borra `expires_at` junto con el cambio de estado. El cron horario expira y anonimiza pedidos vencidos en `pending_confirmation`, `confirmed`, `packing` o `shipped`.

La migración `0004_order_retention.sql` conserva los datos existentes al convertir cuatro columnas obligatorias en columnas que admiten `NULL`. Cuando vence un pedido elegible, el cron elimina el nombre, correo, teléfono, dirección y notas de envío. Conserva el número, la ciudad, los importes y los ítems. La actualización y el evento de sistema sin datos personales se guardan juntos. Repetir el cron conserva un único evento de anonimización por pedido.
