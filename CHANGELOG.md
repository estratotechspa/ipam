# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado semántico.

## [Sin publicar]
### Correcciones
- **Idempotencia de reservas:** repetir una `Idempotency-Key` con otro tamaño (`mascara`), VLAN, nombre de VLAN o ticket ahora responde `409 idempotencia_conflicto`. Antes solo se comparaban pool, CIDR y VPC, y un cambio de máscara devolvía en silencio la reserva original (un /26 donde se había pedido un /27). Lo que el agente no indica sigue sin contar.

### Seguridad
- **Sesiones OIDC revalidadas:** el rol y la existencia de la persona se consultan en la base cada `SESSION_REVALIDAR_SEG` (300 s); una baja o un cambio de rol rige en ese tiempo. `SESSION_HORAS` baja de 8 a 4. La cookie pasa a un formato nuevo (se entra de nuevo una vez).
- **Webhook de Jira con timestamp:** exige `x-ipam-timestamp` y la firma `HMAC(secreto, "<timestamp>.<cuerpo>")` con ventana de ±5 min. **Cambio incompatible** para quien firmaba solo el cuerpo.
- `POST /api/jira/simular` solo fuera de producción o con `ENABLE_SIMULADOR=true`; `/api/jira/estado` informa `simulador`.
- `POST /auth/logout` exige `X-Requested-With` (CSRF); se agregan `Permissions-Policy` y `Referrer-Policy`.

### Rendimiento y datos
- La sincronización con Jira corre en segundo plano con reintentos (`JIRA_REINTENTOS`, `JIRA_REINTENTO_MS`); el resultado queda en `eventos`.
- `GET /api/asignaciones` pagina (`limit` máx. 1000, `offset`), filtra (`pool`, `ambiente`, `q`), ordena y devuelve `X-Total-Count`. **Cambio:** antes devolvía todo sin límite.
- El Excel se genera por streaming (lotes de 1000, instantánea consistente) e incluye todas las IPs fijas (antes, 2000).
- `npm run purgar` (usuario migrador) borra eventos anteriores a `RETENCION_DIAS` (365), por lotes; la auditoría no se purga (solo inserción). Índice `eventos_ts_idx` (idempotente, sin cambiar la versión del esquema).

### Rendimiento de la base de datos
- Cinco índices de apoyo (idempotentes, opcionales, sin cambiar la versión del esquema): historial de auditoría por pool y por segmento (de hasta ≈ 330 ms a < 1 ms con 1.000.000 de filas y creciendo sin tope), clave foránea `reservas.asignacion_id`, lista de asignaciones por pool e IPs por pool. Mediciones con 100.000 segmentos en [BASE-DE-DATOS](docs/BASE-DE-DATOS.md). Nueva prueba `indices.test.js` que exige que las consultas reales usen sus índices. Se aplican con `npm run migrar`; incluyen `eventos_ts_idx` de la purga por retención.

### Seguridad de la interfaz
- **Liberar un segmento pide una segunda confirmación** («Última confirmación»): además del motivo, hay que escribir el CIDR exacto para continuar. Aplica a Asignaciones, a la ficha del segmento y a liberar una reserva ya confirmada. Es una protección de la interfaz; la API no cambia.

### Imagen
- **El runtime pasa a Node 22.** La base Chainguard gratuita solo publica `latest` (Node 26): producción corría una versión mayor distinta de la que prueba el CI. Ahora es `gcr.io/distroless/nodejs22-debian13` fijada por digest: sin shell ni gestor de paquetes, usuario `65532`, amd64 y arm64. Verificado con sistema de archivos de solo lectura, sin capacidades y `no-new-privileges`: arranca, `/healthz` y `/readyz` responden y el healthcheck queda `healthy`.

### CI
- **El job «construir» ya no falla al azar.** La etapa `deps` del Dockerfile corre en la arquitectura del que construye (`FROM --platform=$BUILDPLATFORM`) y no bajo emulación QEMU: ahí `npm ci` terminaba con `Illegal instruction` (SIGILL) en la mayoría de las primeras pasadas del build arm64. Es seguro porque las dependencias de producción son JavaScript puro; una prueba nueva (`arquitectura.test.js`) falla si se agrega una dependencia nativa o por plataforma. Verificado construyendo y cargando las dependencias en amd64 y arm64.

### Correcciones
- Reservas: si se cambiaba un filtro y enseguida se escribía en otro (o dos cargas se cruzaban), una respuesta vieja podía redibujar la pantalla y hacer perder lo escrito. Ahora solo la carga más reciente redibuja. Detectado por una prueba intermitente (≈ 1 de cada 60 ejecuciones).

### Documentación
- Nuevo [Manual de usuario](docs/MANUAL-DE-USUARIO.md) (guía paso a paso, con capturas en `docs/img/`); el [Manual de uso](docs/MANUAL-DE-USO.md) queda como referencia pantalla por pantalla y se corrigió: los cinco indicadores de Pools y los umbrales de las barras.
- `main` pasa a ser la línea hexagonal (reservas, tokens, pools, cuentas locales); el monolito anterior queda en la etiqueta `main-monolito-antes-de-unificar`.

### Interfaz (bloque 4b)
- `public/app.js` (2.400 líneas) se divide en un punto de entrada y 15 módulos ES en `public/modulos/` (uno por pestaña o responsabilidad). Sin cambios de comportamiento: las 35 pruebas e2e y las unitarias pasan igual. Nueva prueba que valida las importaciones y el tamaño de cada módulo.

### Interfaz (bloque 4a)
- **Diseño y accesibilidad:** tokens de diseño (tipografía, espaciado, radios) con modo oscuro, contraste AA medido, foco visible, enlace «saltar al contenido», navegación con `aria-current`, tablas con `scope`/`aria-sort` y conjunto de iconos propio (`/iconos.js`) en lugar de glifos.
- **Visualización:** barras de uso con umbrales (verde < 70 %, ámbar hasta 90 %, rojo por encima) e indicador de alerta, indicadores «Pools sobre 80 %» y «Espacio libre», mapa de bloques en la ficha del pool, Asignaciones con búsqueda, orden por columna y paginación.
- **Facilidad de uso:** diálogo de confirmación accesible y avisos (toasts) en lugar de `confirm`/`alert`/`prompt`; validación de CIDR en vivo; liberar un segmento pide motivo; pestaña Jira muestra primero el estado real y pliega los diagramas.
- **Entrada:** página `/login` (solo SSO) y páginas de error propias (dominio no permitido, sin rol, correo sin verificar, sesión expirada o cerrada, demasiados intentos); errores del proveedor redirigen a `/login?error=…`. Favicon de la marca en `/favicon.svg`.
- Pruebas: `calculos.test.js`, `ui.test.js`, ampliación de `auth.test.js` y `e2e/bloque4.spec.js`.

### Agregado
- **Cerrar sesión en modo Basic:** el botón «Salir» ahora también aparece con usuario y contraseña. Llama a `/auth/salir` (401 con el desafío de Basic) con credenciales falsas para que Chromium y Firefox olviden las guardadas, y lleva a «Sesión cerrada». Es de mejor esfuerzo (Safari puede recordarlas).
- Helm: `auth.local` (variable `AUTH_LOCAL`) para habilitar las cuentas locales; también en `docker-compose.yml`.

### Cambiado
- La pestaña **Usuarios** la ve todo admin; sin cuentas habilitadas (Basic sin `AUTH_LOCAL`, o acceso abierto) explica cómo habilitarlas en vez de ocultarse.
- **«＋ Nuevo pool»** es un botón visible y el texto indica que el pool se crea en el ambiente que corresponda (dev, qa, pre o prod).
- La barra superior muestra usuario y rol también en modo Basic.

## [0.3.0] - 2026-10-21
### Agregado
- **Disponibilidad por máscara:** `GET /pools/{id}/disponibilidad` y un panel en Asignar directo y Nueva reserva (direcciones por bloque, utilizables y bloques libres; el selector muestra «/24 · 15 libres»). README en la raíz y análisis de un IPAM comercial (`docs/ANALISIS-IPAM-COMERCIAL.md`).
- **Reservas tentativas** para agentes: `POST/GET /api/reservas`, `GET /api/reservas/:id`, confirmar y liberar; TTL de 24 h (máximo 72), idempotencia con `Idempotency-Key`, expiración perezosa más barredor coordinado, y la regla *human-in-the-loop* (un agente confirma con `aprobado_por` y `referencia`).
- **Tokens de servicio** con rol `agente` o `lector` (`ipam_` + 43 caracteres, solo se guarda el hash, vencen y se revocan); `Authorization: Bearer` se evalúa primero en cualquier modo.
- **Contrato OpenAPI 3.1** (`/api/openapi.json`), rutas versionadas `/api/v1/…` con alias compatibles `/api/…`, validación de entrada generada desde el contrato y pruebas de contrato.
- **Límite de peticiones** por actor e IP con ventana deslizante (contadores en PostgreSQL), freno a la fuerza bruta y **cuota de reservas por token**.
- **Interfaz:** pestañas Reservas (con cuenta regresiva) y Tokens (alta con copia única).
- **Observabilidad:** `/metrics` (Prometheus), trazas OpenTelemetry opcionales, logs JSON con `request_id`, alertas y dashboard listos para copiar.
- **Portabilidad:** arquitectura hexagonal, `config` única con `NOMBRE_FILE`, `/healthz` y `/readyz`, `npm run migrar`, `DATABASE_SCHEMA`, roles `ipam_migrador` e `ipam_app`, imagen multi-arquitectura, manifiestos por plataforma en `despliegue/` y guardia de portabilidad.
- **Calidad y seguridad verificables:** ESLint, Prettier, `tsc --checkJs`, cobertura ≥ 80 %, pruebas de propiedades, regla de lint contra SQL concatenado, escaneos (gitleaks, Semgrep, Trivy, Checkov), SBOM CycloneDX, modelo de amenazas.
- **CI portable** para GitHub y GitLab con la lógica en `Makefile` y `scripts/ci/`; Renovate.
- Contrato YAML de redes (propuesta pendiente de validar), ejemplos y pipeline de GitLab para el repo de infraestructura del cliente.

### Agregado
- **Cuentas de usuario administrables** (esquema versión 7): el admin pre-registra por correo y da de baja (SSO), o crea cuentas locales con clave temporal de un solo uso, cambio obligatorio, restablecer, desactivar y eliminar (`AUTH_LOCAL=true`, modo Basic). `POST/DELETE /usuarios`, `/usuarios/{email}/desactivar|activar|restablecer-clave` y `POST /yo/clave`.

### Cambiado
- Cada asignación tiene un **ID legible** (`ASG-000123`, columna generada; esquema versión 6): visible y buscable en la interfaz, en la API (`codigo`) y en el Excel. **Liberar** pide un motivo que queda en la auditoría. Hay que migrar el esquema antes de desplegar esta versión.
- **Nueva reserva** desde la interfaz (solicitante y admin). **Asignar directo** (antes «Solicitar») pasa a ser solo de admin, también en la API (`POST /solicitudes`): el solicitante pide una reserva y un admin la aprueba.
- **Jira ya no asigna directo:** el webhook (y el simulador) crea una **reserva** y un **admin** debe aprobarla en la pestaña Reservas; recién ahí se asigna el CIDR (origen `jira`) y se actualiza el ticket. Idempotente por ticket; sin aprobación, expira sola.
- Filtro por ambiente y proveedor en Pools, Asignaciones y Reservas; las máscaras van de /8 a /32 en toda la interfaz.
- En producción el servicio **no arranca** sin autenticación (salvo `ALLOW_ANONYMOUS=true`); el chart de Helm falla sin autenticación.
- Los errores no devuelven detalles internos (solo `request_id`); el webhook de Jira sin secreto queda deshabilitado en producción.
- Las pruebas se ejecutan en serie y cada archivo usa su propia base de datos temporal.
- Node ≥ 22. Dependabot se reemplaza por Renovate.

### Seguridad
- Auditoría de solo inserción (disparador y permisos), cabeceras y cookies endurecidas, protección SSRF en el webhook saliente.

## [0.1.0] - 2026-10-20
- Versión inicial del MVP: pools, asignaciones sin solapamiento, Jira, exportación, OIDC y roles, respaldos, imagen endurecida y CI.
