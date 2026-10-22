# Configuración (variables de entorno)

> **Este archivo se genera** con `npm run doc:config` desde `mvp/src/config.js`; no lo edites a mano (el CI verifica que esté al día).
> Todo se configura por variables de entorno (12-factor). En Kubernetes van en `values.yaml` (ver [DESPLIEGUE](ops/DESPLIEGUE.md)).
> Los **secretos** aceptan también la forma `NOMBRE_FILE=/ruta/al/archivo` (Kubernetes Secret montado, Docker secrets, Secret Manager…); el valor nunca se imprime en logs.
> Los defaults son los seguros: sin configurar nada, en producción el servicio **no arranca** sin autenticación.

Tipos: *texto*, *entero*, *booleano* (`true`/`false`) y *lista* (valores separados por coma).

## General (proceso y servidor)

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `NODE_ENV` | texto | development | Entorno. Con «production» se activan las protecciones de arranque seguro. Ej.: `production` |
| `PORT` | entero | 8080 | Puerto HTTP en el que escucha el servicio.  |
| `ROL` | texto | todos | Qué hace esta réplica: «api» (solo HTTP), «worker» (solo barredor) o «todos». Opciones: api, worker, todos. |
| `LOG_LEVEL` | texto | info | Nivel de log: debug, info, warn o error. Opciones: debug, info, warn, error. |
| `TRUST_PROXY` | texto | (vacío) | Saltos de proxy delante de la app (número). Hace que la IP del cliente, las cookies Secure y el rate limit funcionen tras un balanceador. Ej.: `1` |
| `HSTS` | booleano | false | Envía Strict-Transport-Security. Actívalo solo si el acceso es siempre por HTTPS.  |
| `PUBLIC_URL` | texto | (vacío) | URL pública del IPAM (base del login OIDC y de los enlaces). Obligatoria con OIDC. Ej.: `https://ipam.empresa.example` |
| `APAGADO_TIMEOUT_MS` | entero | 15000 | Tiempo máximo para terminar las peticiones en curso al recibir SIGTERM.  |
| `SOLICITUD_TIMEOUT_MS` | entero | 30000 | Tiempo máximo que el servidor espera para recibir una petición completa.  |
| `MIGRAR_AL_ARRANCAR` | booleano | false | EXCEPCIÓN: aplica el esquema al arrancar (para entornos sin job previo, p. ej. el POC). Por defecto la app NO toca el esquema.  |
| `ALLOW_ANONYMOUS` | booleano | false | Permite arrancar en producción sin OIDC ni Basic (acceso abierto como admin). Solo para demos.  |
| `CONFIRMACION_EXIGE_APROBADOR` | booleano | true | Un token de servicio debe indicar quién aprobó (aprobado_por) y la referencia (MR) al confirmar. Regla human-in-the-loop.  |
| `BARREDOR_INTERVALO_SEGUNDOS` | entero | 60 | Cada cuánto corre el barredor (limpia reservas vencidas y contadores).  |
| `CUOTA_RESERVAS_POR_TOKEN` | entero | 20 | Reservas «reservada» vigentes simultáneas por token (se puede fijar otra al crearlo).  |
| `LIMITE_ALMACEN` | texto | postgres | Dónde se cuentan las peticiones: «postgres» (varias réplicas) o «memoria» (solo pruebas). Opciones: postgres, memoria. |

## Límites de cuerpo

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `JSON_LIMIT` | texto | 100kb | Tamaño máximo del cuerpo JSON de las peticiones normales. Ej.: `100kb` |
| `JSON_LIMIT_IMPORTAR` | texto | 5mb | Tamaño máximo del cuerpo en POST /api/importar (respaldos). Ej.: `5mb` |

## Base de datos

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `DATABASE_URL` | texto | (secreto) | Cadena de conexión a PostgreSQL de la aplicación (usuario con permisos DML). **Obligatoria.** Secreta. |
| `DATABASE_URL_MIGRACION` | texto | (secreto) | Cadena de conexión del usuario migrador (DDL). Solo la usa `npm run migrar`. Si falta, se usa DATABASE_URL. Secreta. |
| `DATABASE_SCHEMA` | texto | public | Esquema de PostgreSQL donde viven las tablas del IPAM. Ej.: `ipam` |
| `DATABASE_SSL` | texto | (vacío) | TLS hacia la base: «disable», «require» (cifra sin verificar) o «verify-full» (verifica el certificado). Vacío = lo que diga DATABASE_URL (sslmode). Opciones: , disable, require, verify-full. |
| `DATABASE_SSL_CA` | texto | (vacío) | Certificado de la autoridad (PEM) para verify-full. Acepta la forma _FILE.  |

## Base de datos (conexiones)

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `DB_POOL_MAX` | entero | 10 | Máximo de conexiones del pool por réplica.  |
| `DB_CONNECT_TIMEOUT_MS` | entero | 5000 | Tiempo máximo para abrir una conexión a la base.  |
| `DB_STATEMENT_TIMEOUT_MS` | entero | 15000 | Tiempo máximo de una consulta (statement_timeout).  |
| `DB_IDLE_TIMEOUT_MS` | entero | 30000 | Tiempo tras el cual se cierra una conexión ociosa.  |

## Acceso básico (POC)

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `APP_USER` | texto | (vacío) | Usuario del modo Basic (un solo usuario, rol admin). Ej.: `admin` |
| `APP_PASS` | texto | (secreto) | Contraseña del modo Basic. Acepta texto plano o un hash `scrypt$…` (recomendado; ver `npm run hash-password`). Secreta. |

## Sesión

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `SESSION_SECRET` | texto | (secreto) | Clave (≥ 32 caracteres) con la que se firma la cookie de sesión OIDC. Secreta. |
| `SESSION_HORAS` | entero | 8 | Duración de la sesión OIDC.  |
| `COOKIE_SECURE` | texto | auto | Atributo Secure de las cookies: «auto» (si PUBLIC_URL es https o la petición llegó por HTTPS), «true» o «false». Opciones: auto, true, false. |

## Acceso con OIDC (SSO)

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `OIDC_ISSUER` | texto | (vacío) | URL del emisor OpenID Connect (Google, Entra, Okta, Keycloak…). Vacío = sin OIDC. Ej.: `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | texto | (vacío) | Identificador del cliente OIDC.  |
| `OIDC_CLIENT_SECRET` | texto | (secreto) | Secreto del cliente OIDC. Secreta. |
| `OIDC_SCOPES` | texto | openid email profile | Alcances solicitados al proveedor.  |
| `OIDC_ALLOW_INSECURE` | booleano | false | Permite un emisor OIDC por HTTP. Solo para pruebas.  |
| `OIDC_ALLOWED_DOMAINS` | lista | (vacía) | Dominios de correo permitidos (separados por coma). Vacío = cualquiera. Ej.: `empresa.example` |
| `OIDC_ADMIN_EMAILS` | lista | (vacía) | Correos con rol admin siempre (evita quedar fuera).  |
| `OIDC_REQUESTER_EMAILS` | lista | (vacía) | Correos con rol solicitante.  |
| `OIDC_READER_EMAILS` | lista | (vacía) | Correos con rol lector.  |
| `OIDC_GROUPS_CLAIM` | texto | groups | Nombre del claim con los grupos del usuario.  |
| `OIDC_ADMIN_GROUPS` | lista | (vacía) | Grupos con rol admin.  |
| `OIDC_REQUESTER_GROUPS` | lista | (vacía) | Grupos con rol solicitante.  |
| `OIDC_READER_GROUPS` | lista | (vacía) | Grupos con rol lector.  |
| `OIDC_DEFAULT_ROLE` | texto | lector | Rol de quien no coincide con nada. «ninguno» = solo entran los mapeados.  |

## Tokens de servicio

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `TOKEN_VIDA_DIAS` | entero | 90 | Vigencia por defecto de un token de servicio nuevo.  |

## Reservas

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `RESERVA_TTL_HORAS` | entero | 24 | Vigencia por defecto de una reserva sin confirmar.  |
| `RESERVA_TTL_MAX_HORAS` | entero | 72 | Vigencia máxima que se puede pedir para una reserva.  |

## Límite de peticiones

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `RATE_LIMIT_POR_MINUTO` | entero | 120 | Peticiones de lectura por minuto por actor (token o usuario).  |
| `RATE_LIMIT_ESCRITURA_POR_MINUTO` | entero | 30 | Peticiones de escritura por minuto por actor.  |
| `RATE_LIMIT_IP_POR_MINUTO` | entero | 600 | Peticiones por minuto por dirección IP (suma de actores detrás de un mismo NAT).  |
| `RATE_LIMIT_AUTH_FALLOS_POR_MINUTO` | entero | 10 | Intentos de autenticación fallidos por minuto por IP (freno a la fuerza bruta).  |

## Métricas

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `METRICS_TOKEN` | texto | (secreto) | Token de lectura para GET /metrics (Authorization: Bearer). Sin token ni redes permitidas, /metrics queda deshabilitado. Secreta. |
| `METRICS_ALLOW_CIDRS` | lista | (vacía) | Redes IPv4 (CIDR) desde las que se puede leer /metrics. Ej.: `10.0.0.0/8` |

## Eventos y webhook saliente

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `EVENTOS_PUBLICADORES` | lista | log | Adaptadores de eventos activos: «log» y/o «webhook». Ej.: `log,webhook` |
| `EVENTOS_WEBHOOK_URL` | texto | (vacío) | Destino del webhook saliente de eventos. Ej.: `https://eventos.empresa.example/ipam` |
| `EVENTOS_WEBHOOK_SECRET` | texto | (secreto) | Clave con la que se firma (HMAC-SHA256) cada evento saliente. Secreta. |
| `EVENTOS_WEBHOOK_PERMITIR_HOSTS` | lista | (vacía) | Hosts a los que se permite llegar aunque resuelvan a una dirección privada (lista explícita anti-SSRF).  |
| `EVENTOS_WEBHOOK_TIMEOUT_MS` | entero | 5000 | Tiempo máximo de cada intento del webhook.  |
| `EVENTOS_WEBHOOK_REINTENTOS` | entero | 3 | Intentos máximos del webhook ante errores transitorios.  |

## Trazas (OpenTelemetry)

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `OTEL_TRACES_EXPORTER` | texto | none | Exportador de trazas: «none» (apagado) u «otlp». Opciones: none, otlp. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | texto | (vacío) | Endpoint OTLP/HTTP del colector. Ej.: `http://otel-collector:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | texto | (secreto) | Cabeceras del exportador (clave=valor,clave=valor). Secreta. |
| `OTEL_SERVICE_NAME` | texto | ipam | Nombre del servicio en las trazas.  |
| `OTEL_TRACES_SAMPLER_ARG` | texto | 1 | Proporción de trazas que se muestrean (0 a 1).  |

## Jira

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `JIRA_WEBHOOK_SECRET` | texto | (secreto) | Clave HMAC del webhook entrante de Jira. En producción no tiene valor por defecto: sin ella el webhook queda deshabilitado. Secreta. |
| `JIRA_ENABLED` | booleano | false | Activa la integración saliente con Jira.  |
| `JIRA_BASE_URL` | texto | (vacío) | URL de Jira Cloud. Ej.: `https://empresa.atlassian.net` |
| `JIRA_EMAIL` | texto | (vacío) | Correo de la cuenta de servicio de Jira.  |
| `JIRA_API_TOKEN` | texto | (secreto) | Token de API de Jira. Secreta. |
| `JIRA_PROJECT` | texto | (vacío) | Clave del proyecto de Jira. Ej.: `NET` |
| `JIRA_ISSUE_TYPE` | texto | Task | Tipo de ticket que se crea.  |
| `JIRA_DONE_TRANSITION` | texto | Done | Transición final del ticket.  |

## Marca

| Variable | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `BRAND_NAME` | texto | IPAM | Nombre en la barra y el título.  |
| `BRAND_SUBTITLE` | texto | (vacío) | Texto pequeño junto al nombre.  |
| `BRAND_FOOTER` | texto | (vacío) | Pie de página.  |
| `BRAND_COLOR_TOP` | texto | #12203a | Color de la barra superior (#rrggbb).  |
| `BRAND_COLOR` | texto | #2d6cdf | Color de botones (#rrggbb).  |
| `BRAND_COLOR_ACCENT` | texto | #4da3ff | Color de acento (#rrggbb).  |
| `BRAND_LOGO_FILE` | texto | (vacío) | Ruta de un logo (png, jpg, webp o svg ≤ 512 KB).  |
