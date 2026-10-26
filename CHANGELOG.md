# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado semántico.

## [Sin publicar]
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
