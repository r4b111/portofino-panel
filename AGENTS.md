# Portofino Orders

- Usa TypeScript estricto y valida los datos en los límites de la API.
- Conserva el SQL de `migrations/0001_orders.sql` como migración inicial exacta.
- Guarda únicamente hashes de tokens de seguimiento y cifra los campos personales destinados a cifrado.
- Evita exponer información del comprador, secretos o tokens de seguimiento en registros y respuestas públicas.
- Ejecuta `npm run typecheck` y `npm run db:local` antes de abrir un PR.
- Incluye en Git únicamente los archivos solicitados. Las dependencias, los secretos y la base local son archivos de trabajo.
