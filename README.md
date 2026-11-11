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

`npm run dev` y `npm run db:local` usan exclusivamente el entorno local. Wrangler crea la base local en `.wrangler/`. Para producción, usa siempre `--env production`. Para probar autenticación, copia `.dev.vars.example` a `.dev.vars` y genera un valor aleatorio e independiente para cada variable. Guarda las claves fuera de Git.

- `GET /health` comprueba que el Worker responde.
- `GET /orders/tracking` recibe el token en `X-Tracking-Token` y devuelve estado y datos de envío sin información personal.
- `GET /admin/orders/:number` consulta el estado y los importes del pedido con una sesión administrativa.

Ejecuta `npm test` en el pool de Cloudflare Workers. La suite completa debe reportar **58 pruebas**. Para ejecutar solo las suites de cifrado y tokens, usa `npm test -- src/lib/crypto.test.ts src/lib/tokens.test.ts`.

## Criptografía

`encrypt` y `decrypt` usan AES-256-GCM con una clave derivada mediante SHA-256 del secreto. Cada cifrado usa un IV aleatorio de 12 bytes. El formato es `iv.ciphertext` en base64url sin relleno, con la etiqueta de autenticación incluida en el segundo componente. Usa un secreto aleatorio de alta entropía.

`generateTrackingToken` produce 32 bytes aleatorios en base64url. Entrega el valor original al cliente y guarda únicamente el SHA-256 hexadecimal devuelto por `hashTrackingToken`.

## Acceso administrativo

Configura `ADMIN_SESSION_SECRET` con al menos 32 caracteres aleatorios e independientes de `DATA_SECRET`. Aprovisiona los administradores en D1 con un correo en minúsculas, un rol `owner` o `agent` y el resultado de `hashPassword` de `src/lib/passwords.ts` en `password_hash`. La función usa PBKDF2-SHA-256 con sal aleatoria y exactamente 100 000 iteraciones. Ese valor respeta el tope de PBKDF2 de WebCrypto en el runtime de Cloudflare Workers. [Límite de workerd](https://github.com/cloudflare/workerd/issues/1346)

Si un administrador tiene un hash con otro número de iteraciones, aprovisiona un nuevo hash de 100 000 iteraciones mediante el restablecimiento de su contraseña.

Envía `{ "email": "...", "password": "..." }` como JSON a `POST /admin/login` y agrega `totp` como texto de seis dígitos cuando la cuenta lo requiera. El formulario de `/login` ofrece el mismo campo. Tras cinco intentos fallidos en un minuto por correo o por IP, las solicitudes siguientes devuelven `429` hasta que se abra una ventana nueva. La sesión se entrega en una cookie firmada `__Host-admin_session` con `HttpOnly`, `Secure` y `SameSite=Strict`. Vence a las ocho horas. El servidor consulta el rol vigente al autenticar cada solicitud.

`PATCH /admin/orders/:number/status` recibe `{ "status": "...", "expectedVersion": 1 }`. El mapa de transiciones está en `src/lib/orders/state.ts`. La cancelación exige el rol `owner`. Cada cambio válido y su registro en `audit_log` se guardan juntos y el cambio de versión protege contra escrituras concurrentes.

### Activar TOTP

1. Genera un secreto Base32 de 32 caracteres en una terminal privada.

   ```bash
   node -e 'const {randomInt} = require("node:crypto"); const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; console.log(Array.from({length: 32}, () => alphabet[randomInt(alphabet.length)]).join(""));'
   ```

2. Añade el secreto manualmente en tu aplicación de autenticación como código basado en el tiempo. Configura SHA-1, seis dígitos y un intervalo de 30 segundos si la aplicación ofrece esos ajustes.
3. En la consola de D1 del entorno correspondiente, guarda ese mismo secreto en `admins.totp_secret` para el correo de la cuenta. Sustituye los dos marcadores de esta sentencia y comprueba que se actualizó una fila.

   ```sql
   UPDATE admins SET totp_secret = 'SECRETO_BASE32' WHERE email = 'admin@example.com';
   ```

4. En una ventana privada, envía las credenciales correctas a `POST /admin/login` sin `totp` y comprueba que responde HTTP 401 con `totp_required`. Repite la solicitud con `totp` como texto de seis dígitos y comprueba que responde HTTP 200. También puedes verificarlo en `/login` con el campo de autenticación. Usa un código nuevo si ya lo utilizaste.

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

`POST /api/orders` recibe `name`, `email`, `phone`, `address`, `city` opcional y entre 1 y 20 ítems. Cada ítem requiere `productId`, `qty` de 1 a 99 y `unitAmount` entero no negativo. Configura `DATA_SECRET` y carga los productos en `order_catalog` después de aplicar `0008_order_catalog.sql`. El servidor calcula los importes con el precio registrado en el catálogo.

La respuesta `201` entrega `{ number, token, expiresAt }`. Guarda el token en el cliente al recibirlo. El pedido pendiente vence a las 72 horas. Si se confirma, se elimina ese vencimiento y el código de seguimiento sigue funcionando.

## Chat embebido

Carga el script clásico del Worker en la página privada del pedido y asigna al componente el token que recibiste al crearlo.

```html
<script defer src="https://pedidos.example.com/pf-chat.js"></script>
<pf-chat token="TOKEN_DEL_PEDIDO"></pf-chat>
```

Sustituye el dominio de ejemplo. Si la tienda usa CSP, permite el origen del Worker en `script-src` y `frame-src`. Al abrir la conversación tras recargar, el widget recupera el estado y el historial del pedido. Si se interrumpe la conexión, reintenta con pausas crecientes de hasta 30 segundos. Si se alcanza el límite de envío, muestra un aviso y conserva el borrador.


## Confirmar envío

Un agente autenticado puede enviar `PATCH /admin/orders/:number/shipping` con `{ "carrier": "Inter Rapidísimo", "shippingCost": 12000, "shippingEtaDays": 3 }`. El costo debe expresarse en unidades enteras de la moneda del pedido. Se admite costo cero para envío gratis. El pedido debe estar pendiente de confirmación.

El servidor suma el costo al subtotal guardado y confirma el pedido en el mismo batch que registra el cambio en auditoría. El widget muestra subtotal, envío, total, transportadora y plazo estimado. Antes de confirmar la cotización, el costo y el total aparecen como «Por confirmar».

## Estados de pago

Al confirmar un pedido con pago pendiente (`unpaid`), el sistema activa el pago contra entrega (`cod_pending`). Al marcarlo como entregado, registra el cobro (`cod_collected`). Un pedido con estado de pago `unpaid` no puede pasar a entregado.

Solo un `owner` puede usar `PATCH /admin/orders/:number/payment`. Envía `{ "paymentStatus": "paid" }` para registrar un pago desde `unpaid` o `cod_pending`, o `{ "paymentStatus": "refunded" }` para registrar un reembolso desde `paid` o `cod_collected`. Cada cambio agrega un evento `payment_changed` cuyo payload contiene únicamente los dos estados de pago.

## Retención de pedidos

Al confirmar se borra `expires_at` junto con el cambio de estado. El cron horario expira y anonimiza pedidos vencidos en `pending_confirmation`, `confirmed`, `packing` o `shipped`.

La migración `0004_order_retention.sql` conserva los datos existentes al convertir cuatro columnas obligatorias en columnas que admiten `NULL`. Cuando vence un pedido elegible, el cron elimina el nombre, correo, teléfono, dirección y notas de envío. Conserva el número, la ciudad, los importes y los ítems. La actualización y el evento de sistema sin datos personales se guardan juntos. Repetir el cron conserva un único evento de anonimización por pedido.

## Despliegue y rotación de secretos

El entorno `production` de Wrangler usa el binding `DB` de la base `portofino` con `database_id = "f05fbc67-1665-4f11-8fa6-abbdbd33949d"`. El valor de `STOREFRONT_ORIGIN` en `[env.production.vars]` autoriza el origen HTTPS de la tienda. Si falta o es inválido, el navegador bloquea la carga del chat dentro de un iframe.

Antes de publicar, revisa el historial con `npx wrangler d1 migrations list DB --remote --env production`. Producción ya aplicó hasta `0005_shipping_total.sql`. Los nombres siguientes son `0007_rate_limits.sql` y `0008_order_catalog.sql`. Aplica las migraciones pendientes con `npx wrangler d1 migrations apply DB --remote --env production`. Publica producción siempre con `npx wrangler deploy --env production`. Si ejecutas `npx wrangler deploy` sin ese flag, Wrangler usa la configuración raíz y puede sobrescribir el Worker `portofino-orders-prod` con la configuración local. El Worker de producción se llama `portofino-orders`.

- Rota `ADMIN_SESSION_SECRET` con `npx wrangler secret put ADMIN_SESSION_SECRET --env production`. Las sesiones previas deberán volver a autenticarse.
- Si cambias `TELEGRAM_BOT_TOKEN` o `TELEGRAM_WEBHOOK_SECRET`, actualiza los secretos en el Worker y registra de nuevo el webhook de Telegram con el valor correspondiente de `secret_token`.
- Para rotar `DATA_SECRET`, prepara una migración que vuelva a cifrar los datos existentes con la clave nueva antes de retirar la anterior. El Worker usa una sola clave de datos.
