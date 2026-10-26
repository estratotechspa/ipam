# IPAM · MVP

Gestión de segmentos de red (IPv4): pools, asignaciones sin solapamiento, sugerencia de segmentos libres e integración con Jira por webhook firmado.

**Stack:** Node 20 + Express · PostgreSQL 16 · Docker Compose.

## Levantar en local
```bash
docker compose up -d --build        # http://localhost:8080
docker compose down -v              # apaga y borra la base (vuelve a los datos de ejemplo)
```
Variables opcionales (archivo `.env` junto al compose): `APP_USER` y `APP_PASS` (clave de acceso) o `OIDC_*` + `PUBLIC_URL` + `SESSION_SECRET` (ver «Acceso, roles y auditoría»), `DB_PASSWORD`, `JIRA_WEBHOOK_SECRET`, `PORT`.
El compose es una **demo local**: corre con `NODE_ENV=development` (abierto y con simulador de Jira). La imagen, en cambio, trae `NODE_ENV=production`: ahí la app **no arranca** sin autenticación ni con un secreto de webhook de ejemplo (ver «Acceso, roles y auditoría»).
Pruebas unitarias: `npm test`.

## Variables de entorno de la app
| Variable | Por defecto | Para qué |
|---|---|---|
| `DATABASE_URL` | — | conexión a PostgreSQL |
| `DB_POOL_MAX` · `DB_CONNECT_TIMEOUT_MS` · `DB_STATEMENT_TIMEOUT_MS` | 10 · 5000 · 15000 | tamaño del pool, espera máxima por una conexión y duración máxima de cada consulta |
| `JSON_LIMIT` · `IMPORT_LIMIT` | `100kb` · `5mb` | tamaño máximo de un cuerpo JSON; `IMPORT_LIMIT` solo rige en `POST /api/importar` (admin) |
| `RETENCION_DIAS` | 365 | días que se conservan `eventos` y `auditoria`; se purga al arrancar y cada 24 h. `0` = conservar todo |
| `JIRA_REINTENTOS` · `JIRA_REINTENTO_MS` | 3 · 2000 | intentos de la sincronización con Jira (en segundo plano) y espera base entre ellos (× n) |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | tiempo máximo para drenar peticiones al recibir SIGTERM/SIGINT |
| `NODE_ENV` | `production` en la imagen | en `production` la app exige autenticación y `JIRA_WEBHOOK_SECRET` propio, y oculta el simulador de Jira |
| `AUTH_MODE` | se deduce | `oidc` · `basic` · `none`. Vacío: OIDC si hay `OIDC_ISSUER`, Basic si hay `APP_USER`+`APP_PASS`, si no abierto. **En producción el modo abierto hay que pedirlo con `AUTH_MODE=none`**; si no, la app no arranca |
| `JIRA_WEBHOOK_SECRET` | — | secreto del webhook. En producción es obligatorio y no puede ser `dev-secret-cambiar` |
| `ENABLE_SIMULADOR` | `false` | `true` deja disponible `POST /api/jira/simular` en producción (fuera de producción siempre lo está) |
| `SESSION_HORAS` | 4 | duración máxima de la sesión OIDC |
| `SESSION_REVALIDAR_SEG` | 300 | cada cuántos segundos se revalida el rol y la existencia del usuario en la base (`0` = en cada petición) |
| `RATE_LIMIT_AUTH_MAX` · `RATE_LIMIT_AUTH_VENTANA_MIN` | 30 · 15 | peticiones por IP a `/auth/login` + `/auth/callback` por ventana |
| `RATE_LIMIT_WEBHOOK_MAX` | 120 | peticiones por minuto y por IP a `/webhook/jira` |
| `RATE_LIMIT_BASIC_MAX` | 5 | fallos de Basic Auth por minuto y por IP; luego 2× en 15 min y 4× en 1 h (bloqueo progresivo) |
| `TRUST_PROXY` | — | saltos de proxy delante de la app. **Necesario detrás de un ingress** para que los límites por IP usen la IP del cliente y no la del proxy |

## Instalar en Kubernetes con Helm
El chart está en `chart/ipam` (API + PostgreSQL opcional + migración de esquema + Ingress opcional).

```bash
docker build -t ghcr.io/TU_ORG/ipam:0.1.0 . && docker push ghcr.io/TU_ORG/ipam:0.1.0   # o `minikube image load`

# 1) Secretos creados por ti en el clúster (no quedan en values ni en git):
kubectl create namespace ipam
kubectl -n ipam create secret generic ipam-secrets \
  --from-literal=DATABASE_URL='postgres://ipam:CLAVE@ipam-ipam-db:5432/ipam' \
  --from-literal=POSTGRES_PASSWORD='CLAVE' \
  --from-literal=APP_USER='admin' --from-literal=APP_PASS='...' \
  --from-literal=JIRA_WEBHOOK_SECRET='...'

# 2) Instalar (configuración en un values propio):
helm install ipam chart/ipam -n ipam -f mis-valores.yaml \
  --set image.repository=ghcr.io/TU_ORG/ipam --set secrets.existingSecret=ipam-secrets
```
- **Secretos:** con `secrets.existingSecret` usas el Secret que ya tengas (compatible con Sealed Secrets / External Secrets). Si no lo indicas, el chart genera claves aleatorias y las conserva entre `helm upgrade`; se leen con los comandos que imprime `helm status`.
- **Configuración:** `values.yaml` (puerto, recursos, ingress, almacenamiento). Cambiar un valor o un secreto reinicia los pods solo.
- **Base externa (Cloud SQL, RDS…):** `--set postgres.enabled=false` y `DATABASE_URL` en el Secret. El esquema se aplica solo (Job idempotente) en cada install/upgrade.
- **Datos de ejemplo:** `--set seed.enabled=true` (solo en `helm install`).
- **URL:** `--set ingress.enabled=true --set ingress.host=ipam.tudominio.cl` (+ `ingress.className` y `tls`).
- **Webhook de Jira:** debe poder llegar a `https://<host>/webhook/jira`; usa el mismo `JIRA_WEBHOOK_SECRET`.

## Acceso, roles y auditoría
Tres modos, que salen de `AUTH_MODE` o, si no se define, de la configuración: **OIDC** (`OIDC_ISSUER`), **Basic Auth** de un solo usuario (`APP_USER` + `APP_PASS`, solo demos) o **abierto** (demo local; la interfaz lo avisa). Con `NODE_ENV=production` (la imagen) la app **no arranca sin autenticación** —tampoco con credenciales a medias— a menos que el modo abierto se pida expresamente con `AUTH_MODE=none`. `AUTH_MODE=none` junto a `OIDC_ISSUER`/`APP_USER` es una contradicción y tampoco arranca. Helm: `auth.mode`.

**Inicio de sesión con Google Workspace** (cualquier proveedor OpenID Connect funciona igual cambiando `issuer`):
1. En Google Cloud → *APIs y servicios → Credenciales* → *ID de cliente de OAuth* (aplicación web). URI de redirección autorizado: `<PUBLIC_URL>/auth/callback`.
2. Helm: `auth.oidc.issuer=https://accounts.google.com`, `auth.oidc.clientId=…`, `secrets.oidcClientSecret=…`, `config.publicUrl=https://ipam.…`, `auth.oidc.allowedDomains=empresa.cl`, `auth.oidc.adminEmails=quien@empresa.cl`.
3. Microsoft Entra: `issuer=https://login.microsoftonline.com/<tenant>/v2.0` y, si usan grupos, `scopes="openid email profile"` + `groupsClaim`/`adminGroups`.

| Rol | Puede |
|---|---|
| `lector` | ver pools, asignaciones, eventos, exportar a Excel |
| `solicitante` | + solicitar segmentos |
| `admin` | + liberar, simular tickets de Jira, ver auditoría, asignar roles a otras personas |

El rol sale de: correos admin de la configuración (siempre) → rol asignado en la pestaña *Usuarios* → grupos del proveedor → `defaultRole` (`lector`; `ninguno` = solo entran los mapeados). La sesión es una cookie firmada de 4 h (`SESSION_HORAS`); **el rol y la existencia del usuario se revalidan contra la base cada 5 min** (`SESSION_REVALIDAR_SEG`, caché por proceso), así que quien es degradado, cambia de rol o se da de baja lo nota en minutos sin esperar a que caduque la cookie. «Heredar» devuelve al rol que dan sus grupos/la configuración al entrar (que se fija en la cookie; un cambio de grupos en el proveedor sí requiere volver a entrar), y los administradores de `OIDC_ADMIN_EMAILS` no se pueden degradar desde la base. Con varias réplicas un cambio puede tardar hasta esos 5 min en llegar a todas. Cerrar sesión borra la cookie local, no cierra la sesión en Google. Los cambios desde el navegador —incluido `POST /auth/logout`— exigen la cabecera `X-Requested-With: ipam` (defensa CSRF).
**Pantalla de acceso:** con OIDC, quien no tiene sesión llega a `/login` (marca, botón «Entrar con tu cuenta corporativa» y, según `?error=`, un aviso: sesión expirada, acceso revocado, rechazo del proveedor…), no directo al proveedor; el botón lleva a `/auth/login?next=…` y se vuelve a la página pedida. Los rechazos del servidor (dominio no permitido, sin rol, correo no verificado, solicitud expirada, demasiados intentos, sesión cerrada) se muestran como páginas con el estilo de la app —qué pasó, qué hacer y un botón para volver— generadas en `src/paginas.js`, sin scripts en línea. `/login`, `/login.js` y `/app.css` son públicos; el resto sigue exigiendo sesión.
**Límites de tasa** (`express-rate-limit`, por IP): `/auth/login` y `/auth/callback`, `/webhook/jira` y, en modo Basic, bloqueo progresivo tras fallos (5/min → 10/15 min → 20/h; los accesos correctos y la primera petición sin credenciales no cuentan). Responden `429` con `Retry-After`. Los contadores viven en cada réplica. Todo inicio/cierre de sesión, asignación, liberación, exportación y cambio de rol queda en la tabla `auditoria` (pestaña *Auditoría*).

## Respaldos y exposición
- **Respaldos incrementales a GCS** (`postgres.backup.*`): completo semanal + incremental diario + WAL continuo (recuperación a cualquier instante), retención de 4 completos y prueba de restauración mensual. Imagen `mvp/postgres` (PostgreSQL + pgBackRest). Pasos, restauración y qué vigilar: **`docs/OPERACION.md`**.
- **URL interna del cliente** (`ingress.*`, `httpRoute.*`, `config.publicUrl`): ver el mismo documento, que incluye el paso de la POC al tenant del cliente.

## Interfaz: tokens, iconos y accesibilidad
- **Tokens CSS** (`public/app.css`, bloque `:root`): escala tipográfica 12/14/16/20/28 px, espaciado 4/8/12/16/24 px, radios, colores semánticos (ambientes, alertas, umbrales de uso) y modo oscuro por `prefers-color-scheme`. La marca (`brand.css`) solo sobrescribe `--top`, `--blue` y `--accent`.
- **Iconos:** un único set (Lucide, licencia ISC) en `public/iconos.js` como SVG en línea (`currentColor`, 16 o 20 px, `aria-hidden`); el significado siempre lo da el texto al lado. Favicon: `/favicon.svg` (cuatro bloques con el color de la marca) o el logo de la marca si lo hay.
- **Contraste WCAG 2.2 AA** medido, no estimado: `src/ui.test.js` calcula las razones sobre el CSS real (claro y oscuro) y `e2e/accesibilidad.spec.js` sobre lo que pinta el navegador (texto ≥ 4,5:1; anillo de foco, borde de campos y barras ≥ 3:1). **Los colores de marca personalizados (`BRAND_COLOR*`) no se validan**: si usas uno claro, el texto blanco de los botones puede quedar bajo 4,5:1; comprueba tu color antes (p. ej. con la calculadora de contraste de WebAIM).
- **Accesibilidad:** foco visible en todo lo interactivo, enlace «Saltar al contenido», `aria-current` en la navegación, `role="alert"` (errores) y `role="status"` (éxito), etiquetas asociadas a cada campo, tablas con `<thead>` y `<th scope>`, zonas táctiles de 44 px en pantallas táctiles, `prefers-reduced-motion` y sin desplazamiento horizontal a 320 px.

## Marca y dominio configurables
Nada de «EstratoTech» está escrito en el código ni en la imagen: nombre, colores, logo y URL se cambian por configuración.
- Variables: `BRAND_NAME`, `BRAND_SUBTITLE`, `BRAND_FOOTER`, `BRAND_COLOR` (botones), `BRAND_COLOR_TOP` (barra), `BRAND_COLOR_ACCENT`, `BRAND_LOGO_FILE` (ruta de un png/jpg/webp/svg ≤ 512 KB). Colores solo en formato `#rrggbb`.
- Helm: `branding.*` (el logo va en base64: `--set-string branding.logo="$(base64 < logo.png | tr -d '\n')"`).
- Dominio: `config.publicUrl` (o `ingress.host`); es la base del login y de los enlaces. POC: `ipam.estratotech.cl`; luego, el del cliente (p. ej. `ipam.cliente.interno.cl`) cambiando solo ese valor y el registro de retorno en el proveedor OIDC.

## Llevarse el IPAM a otra infraestructura
- **Respaldo lógico:** `GET /api/exportar.json` (admin; botón «Respaldo JSON») entrega pools, asignaciones y roles asignados.
- **Restauración:** `POST /api/importar` con ese JSON (admin). Es todo o nada: si algún segmento se solapa con otro, se rechaza completo (409) y no se importa nada. Los pools que ya existen no se tocan y las asignaciones repetidas se omiten, así que se puede repetir sin duplicar.
  `curl -u … -H 'X-Requested-With: ipam' -H 'Content-Type: application/json' --data @ipam-respaldo.json https://<host>/api/importar`
- La contraseña de la base, los secretos de OIDC/Jira y la marca viven en Secret/ConfigMap/values: se reinstala el chart en el nuevo clúster con otros valores y se importa el JSON.

## Seguridad del contenedor y del chart
- **Imagen:** dos etapas; runtime `cgr.dev/chainguard/node` fijado por digest (sin shell ni gestor de paquetes; Trivy: 0 CRITICAL/HIGH con parche). Usuario `65532`, sistema de archivos de solo lectura, sin capacidades Linux.
- **Imagen propia del cliente:** `docker build --build-arg BASE_IMAGE=<su-imagen-node> --build-arg BUILD_IMAGE=<su-imagen-node> .` (Node ≥ 20 en el PATH, usuario no root).
- **Chart:** `seccomp RuntimeDefault`, ServiceAccount propia sin token montado, `NetworkPolicy` (`networkPolicy.*`; `ingressFrom` para limitar quién llega a la app), Postgres y Job con filesystem de solo lectura y límites de recursos.
- **Cabeceras HTTP:** `helmet` con CSP estricta (`script-src 'self'`) y `Referrer-Policy: no-referrer`; `Permissions-Policy` desactiva cámara, micrófono, geolocalización, pagos, USB… (helmet no la trae: se añade con un middleware propio). Detrás de un ingress: `TRUST_PROXY=1`; con acceso solo por HTTPS: `HSTS=true`.
- **Cadena de suministro:** `publicar.yml` publica en GHCR con SBOM y atestación. Pendiente: firma de imágenes y TLS de extremo a extremo → `docs/DEUDA-TECNICA.md`.

## Cómo está resuelto lo importante
- **Sin solapamientos, garantizado por la base:** restricción de exclusión GiST (`sin_solapamiento`) sobre `(pool, cidr)`; además un trigger exige que el segmento caiga dentro del pool. Aunque alguien inserte directo en la base, se rechaza.
- **Concurrencia:** las asignaciones de un mismo pool se serializan con un bloqueo de transacción (probado: 20 solicitudes simultáneas → 20 segmentos distintos).
- **Jira → IPAM:** `POST /webhook/jira`, cuerpo `{ticket, ambiente, tipo, mascara, vpc}` con dos cabeceras: `x-ipam-timestamp` (segundos desde 1970, UTC) y `x-hub-signature-256: sha256=HMAC-SHA256(JIRA_WEBHOOK_SECRET, "<timestamp>.<cuerpo>")`. La firma cubre el timestamp; se rechaza (`401`) lo firmado hace más de 5 min o en el futuro, y una misma firma no se acepta dos veces dentro de esa ventana (`409`; la memoria de firmas es por réplica). **Cambio incompatible:** quien firmaba solo el cuerpo debe añadir el timestamp. Ejemplo:
  `ts=$(date +%s); sig=$(printf '%s.%s' "$ts" "$cuerpo" | openssl dgst -sha256 -hmac "$SECRETO" | sed 's/^.* //'); curl -H "x-ipam-timestamp: $ts" -H "x-hub-signature-256: sha256=$sig" -H 'Content-Type: application/json' -d "$cuerpo" https://<host>/webhook/jira`

## API
| Método | Ruta | |
|---|---|---|
| GET | `/api/health` | salud (abierta) |
| GET | `/api/pools`, `/api/resumen`, `/api/eventos` | lecturas. `/api/pools` trae `total`, `usadas`, `libres` y `uso` por pool; `/api/resumen` se calcula de la misma consulta (la interfaz ya no lo usa) |
| GET | `/api/asignaciones` | paginada: `limit` (50; máx. 200), `offset`, filtros `pool`, `ambiente`, `q` (CIDR, proyecto/VPC, solicitante o ticket), `orden` (`fecha`·`cidr`·`pool`·`vpc`·`solicitante`·`ticket`·`origen`·`direcciones`) y `dir` (`asc`·`desc`). El total sin paginar va en la cabecera `X-Total-Count` |
| GET | `/api/me` · `/api/usuarios` · `/api/auditoria` | sesión actual · usuarios y roles (admin) · bitácora (admin) |
| GET · POST | `/api/exportar.json` · `/api/importar` | respaldo lógico completo · restauración (admin) |
| GET | `/api/config` · `/brand.css` · `/brand/logo` | marca (abiertos) |
| GET | `/api/exportar.xlsx` | Excel con todos los segmentos (hoja «Segmentos») y los pools (hoja «Pools»); se genera por streaming, sin cargar todo en memoria |
| GET | `/api/jira/estado` | si la integración saliente con Jira está activa, qué variables faltan y si el simulador está disponible |
| GET | `/api/pools/:id/libres?mascara=22` | 3 segmentos libres |
| POST | `/api/solicitudes` `{pool, vpc, cidr?, mascara?}` | 201 · 400 inválido · 409 solapamiento (con conflicto y sugeridos) |
| DELETE | `/api/asignaciones/:id` | liberar |
| POST | `/webhook/jira` | entrada desde Jira (firmada) |
| POST | `/api/jira/simular` | simula un ticket para la demo (firmado igual que el webhook real). Solo fuera de producción o con `ENABLE_SIMULADOR=true`; si no, 404 |

## Integración saliente con Jira (desactivada por defecto)
Código en `src/jira.js`. Se activa con `JIRA_ENABLED=true` más `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT` (opcionales: `JIRA_ISSUE_TYPE`=Task, `JIRA_DONE_TRANSITION`=Done).
- Solicitud desde el panel → crea el ticket en Jira y guarda su clave real en la asignación.
- Ticket que llega por webhook → comenta el rango en el ticket y lo pasa a la transición final.
- **Corre en segundo plano:** la respuesta al usuario no espera a Jira (hasta 3 llamadas de 10 s antes). Si falla, se reintenta (`JIRA_REINTENTOS`) y el resultado queda en la tabla `eventos`: `jira_ticket_creado`, `jira_ticket_actualizado` o `jira_error`. Mientras tanto la asignación lleva su ticket `NET-xxx` interno, que se reemplaza por la clave de Jira al crearse. Un reintento tras un fallo parcial puede duplicar el comentario en Jira.
- Si Jira falla, la asignación se mantiene y queda un evento `jira_error`. Sin activar, todo funciona como antes (tickets `NET-xxx` simulados).
- Aún no probada contra un Jira real. Pendiente para Helm: pasar estas variables al Secret/values del chart.

## Alcance del MVP (lo que NO está)
- Con la integración desactivada, los números de ticket (`NET-xxx`) los genera el IPAM.
- Solo IPv4. Las sesiones se revalidan cada 5 min (no hay cierre inmediato ni «cerrar sesión en todos los dispositivos»); el rol que dan los grupos del proveedor se fija al iniciar sesión.
- Los 6 pools y 12 asignaciones son datos de ejemplo.

## Guion de demo (5 min)
1. **Pools:** estado y uso de cada pool.
2. **Solicitar:** `gke-pods-prod` + `10.64.8.0/22` → solapamiento con NET-142, y sugeridos; «Usar» → asignado con ticket.
3. **Solicitar sin CIDR** (solo máscara) → asigna el primer libre.
4. **Jira:** «Enviar webhook» → se ve el evento recibido, la asignación y la actualización del ticket.
5. **Asignaciones:** aparecen con origen `panel` / `jira`; «Liberar» devuelve el espacio.
