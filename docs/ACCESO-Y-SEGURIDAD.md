# Acceso y seguridad

Cómo se controla quién entra y qué puede hacer. El análisis de amenazas está en [MODELO-DE-AMENAZAS](MODELO-DE-AMENAZAS.md); la calidad del código en [CALIDAD-Y-SEGURIDAD-DEL-CODIGO](CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md); buenas prácticas de uso en [BUENAS-PRACTICAS](BUENAS-PRACTICAS.md).

## 1 · Modos de acceso
| Modo | Para qué | Cómo se activa |
|---|---|---|
| **OIDC (SSO)** | Uso real con personas | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL` |
| **Basic** | POC y demos | `APP_USER` + `APP_PASS` (**hash scrypt**, no texto plano) + `SESSION_SECRET` |
| **Basic + cuentas locales** | Probar varias personas sin SSO | Lo anterior + `AUTH_LOCAL=true` (el admin crea cuentas desde la pestaña Usuarios) |
| **Tokens de servicio** | Agentes y pipelines | Se crean en la pestaña Tokens (siempre disponibles junto a los anteriores) |
| **Abierto** | Solo desarrollo local | `ALLOW_ANONYMOUS=true` (en producción exige esa variable explícita) |

**Seguro por defecto:** con `NODE_ENV=production` y sin ninguno de los modos anteriores, el servicio **no arranca** y dice por qué. El modo Basic arranca pero avisa en el log que es para POC.

## 2 · Roles
`lector < agente < solicitante < admin`.
| Acción | lector | agente | solicitante | admin |
|---|:-:|:-:|:-:|:-:|
| Ver pools, asignaciones, reservas | ✔ | ✔ | ✔ | ✔ |
| Reservar (en la interfaz, «Nuevo segmento» con «Es una reserva» marcada) y liberar **sus** reservas | | ✔ | ✔ | ✔ |
| **Aprobar** (confirmar) reservas | | solo las suyas, con `aprobado_por` | | ✔ (todas) |
| Asignar ahora (directo, sin reserva: «Nuevo segmento» con «Es una reserva» desmarcada) | | | | ✔ |
| Liberar asignaciones, confirmar/liberar reservas ajenas | | | | ✔ |
| Tokens, **usuarios** (pre-registrar, crear cuentas locales, desactivar, eliminar, restablecer clave), auditoría, respaldo e importación | | | | ✔ |
Los usuarios pueden ser `lector`, `solicitante` o `admin`; los tokens, `lector` o `agente`.

**Cómo se decide el rol con SSO** (en orden): correos admin de la configuración (`OIDC_ADMIN_EMAILS`) → rol asignado en la pestaña Usuarios → grupos del proveedor (`OIDC_ADMIN_GROUPS`, `OIDC_REQUESTER_GROUPS`, `OIDC_READER_GROUPS`) → `OIDC_DEFAULT_ROLE` (`lector`).

## 2b · Cuentas de usuario
- **SSO (camino A):** el admin pre-registra por correo y da de baja; una cuenta **desactivada no obtiene rol** al iniciar sesión (salvo los correos de `OIDC_ADMIN_EMAILS`, que son la salida de emergencia por configuración).
- **Cuentas locales (camino B, `AUTH_LOCAL=true`, solo modo Basic):**
  - La contraseña se guarda **solo como hash scrypt**; la clave temporal (16 caracteres aleatorios) se muestra **una vez** y obliga a cambiarla antes de usar la API (mínimo 12 caracteres, distinta de la actual).
  - Desactivar rige **al instante** (se consulta en cada petición). Los intentos fallidos cuentan para el freno por IP. Un usuario inexistente y una clave errónea responden igual (401), y se verifica un hash de relleno para que el tiempo no delate si la cuenta existe.
  - `APP_USER`/`APP_PASS` es el administrador de emergencia: nunca queda fuera nadie aunque se borren las cuentas.
  - **Límites:** no hay MFA, ni recuperación de clave por correo, ni bloqueo por cuenta (solo por IP). Es para POC; para uso real usa SSO.
- Nadie puede desactivarse ni eliminarse a sí mismo; todo queda en la auditoría sin claves.
- **La pestaña Usuarios la ve todo admin.** Con SSO o con `AUTH_LOCAL=true` trae las cuentas; sin ellas (Basic sin `AUTH_LOCAL`, o acceso abierto) explica cómo habilitarlas en vez de ocultarse. En Helm: `auth.local=true`.
- **Cambiar la clave:** cada cuenta local tiene su botón «Mi contraseña». El administrador de emergencia (`APP_USER`/`APP_PASS`) no la cambia desde la interfaz: vive en el Secret/variable (usa un hash `scrypt$…`, ver `npm run hash-password`). Con `AUTH_LOCAL=true` lo habitual es crear cuentas `admin` propias y dejar el de emergencia guardado.
- **Entrar y errores (SSO):** quien no tiene sesión llega a `/login` (pública, sin script en línea); si el proveedor devuelve un error o la persona no está autorizada, ve una página con el motivo y qué hacer, no un JSON. Los eventos «correo sin verificar» quedan auditados.
- **Cerrar sesión:** con SSO, «Salir» borra la cookie. Con Basic no hay sesión que cerrar (el navegador guarda las credenciales): «Salir» llama a `/auth/salir`, que responde 401, y con credenciales falsas hace que Chromium y Firefox **olviden** las guardadas, y lleva a la página «Sesión cerrada». Es un recurso de mejor esfuerzo (Safari puede seguir recordándolas): en un equipo compartido, cierra además la ventana del navegador.

## 2c · Sesiones OIDC, webhook de Jira y cabeceras
- **Sesión:** cookie firmada de `SESSION_HORAS` (4 por defecto). El rol y la existencia de la persona **se revalidan en la base cada `SESSION_REVALIDAR_SEG` (300 s)**: una baja, una eliminación o un cambio de rol rige en ese tiempo sin esperar a que caduque la cookie. En la réplica que atiende el cambio por la API rige al instante; en las demás, hasta ese tiempo (la caché es por réplica). La cookie solo guarda el rol «base» (el que dan el proveedor y la configuración al entrar); «heredar» vuelve a él, y los correos de `OIDC_ADMIN_EMAILS` no se degradan desde la base. Las cookies anteriores a este cambio (sin `v: 2`) obligan a entrar de nuevo una vez. Un rechazo por sesión revocada cuenta en `ipam_auth_rechazos_total{motivo="sesion_revocada"}`.
- **Cerrar sesión (`POST /auth/logout`)** exige `X-Requested-With: ipam` como el resto de los cambios (defensa CSRF); sin ella, 403 y la sesión sigue activa.
- **Webhook de Jira (`POST /webhook/jira`):** exige `x-ipam-timestamp` y la firma `sha256=HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")`. Rechaza lo firmado hace más de 5 min o en el futuro (el reloj del emisor debe estar sincronizado: NTP). Un reenvío exacto dentro de la ventana devuelve la misma reserva (idempotente por ticket), así que no hace falta recordar firmas. Sin `JIRA_WEBHOOK_SECRET` en producción el webhook queda deshabilitado (503).
- **Simulador de Jira (`POST /api/jira/simular`):** solo fuera de producción o con `ENABLE_SIMULADOR=true`; si no, 404. `GET /api/jira/estado` informa `simulador`.
- **Cabeceras:** `Referrer-Policy: no-referrer` (helmet) y `Permissions-Policy` que desactiva cámara, micrófono, geolocalización, pagos, USB… (helmet no la trae: se añade con un middleware propio).

## 3 · Tokens de servicio
- Formato `ipam_` + 43 caracteres (256 bits aleatorios). Se muestra **una sola vez**; en la base solo vive su hash SHA-256.
- Vencen (`TOKEN_VIDA_DIAS`, máximo 365) y se revocan al instante.
- Tienen **cuota** de reservas vigentes (`CUOTA_RESERVAS_POR_TOKEN`, o una propia por token) y **límite de peticiones**.
- El campo «último uso» se actualiza como máximo una vez por minuto.
- Si un token se filtra: **revócalo** en la interfaz y crea otro.

## 4 · Secretos
- Nunca en el repositorio: solo `.env.example` con valores de relleno. En producción viven en las variables de la plataforma o en su gestor de secretos.
- Cualquier secreto acepta `NOMBRE_FILE=/ruta` (Kubernetes Secret, Docker secrets, Secret Manager).
- Los logs **ocultan** credenciales; los errores nunca devuelven detalles internos (solo `request_id`).
- Escaneo de secretos en el CI (gitleaks) y en el hook previo al commit.

## 5 · Base de datos
- Dos roles: `ipam_migrador` (dueño; aplica el esquema) e `ipam_app` (solo DML; **no** crea ni borra tablas ni toca la auditoría). Contraseñas fijadas aparte, nunca en archivos del repo.
- Conexión cifrada (`sslmode=require` como mínimo; con `DATABASE_SSL_CA` se verifica el certificado).
- Auditoría de solo inserción por disparador, y para `ipam_app` por permisos.

## 6 · Superficie web
Cabeceras de seguridad (CSP estricta, HSTS opcional, `nosniff`, sin `X-Powered-By`), cookies `HttpOnly`/`SameSite`/`Secure`, protección CSRF con `X-Requested-With`, límite de tamaño de cuerpo, tiempo de espera de peticiones, y **SSRF** bloqueado en el webhook saliente (no llama a direcciones internas salvo las permitidas en `EVENTOS_WEBHOOK_PERMITIR_HOSTS`).
`/metrics` **nace cerrado** (404): se abre con `METRICS_TOKEN` o con `METRICS_ALLOW_CIDRS`.

## 7 · Contenedor y despliegue
Imagen mínima (distroless, Node 22) fijada por digest, usuario no root (65532), sistema de archivos de solo lectura, `cap_drop: ALL`; en Kubernetes, `NetworkPolicy` y contexto de seguridad estrictos en el chart.

## 8 · Qué hacer ante un incidente
1. Revoca los tokens sospechosos (pestaña Tokens).
2. Revisa la bitácora de auditoría (`GET /api/v1/auditoria`, o el historial en la ficha de cada pool o segmento) por fecha y usuario; el `request_id` lleva a los logs.
3. Rota `SESSION_SECRET` (cierra todas las sesiones) y las contraseñas de los roles de base de datos.
4. Más pasos en el [RUNBOOK](ops/RUNBOOK.md). Reporte de vulnerabilidades: [SECURITY.md](../SECURITY.md).
