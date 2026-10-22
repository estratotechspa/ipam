# Acceso y seguridad

Cómo se controla quién entra y qué puede hacer. El análisis de amenazas está en [MODELO-DE-AMENAZAS](MODELO-DE-AMENAZAS.md); la calidad del código en [CALIDAD-Y-SEGURIDAD-DEL-CODIGO](CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md); buenas prácticas de uso en [BUENAS-PRACTICAS](BUENAS-PRACTICAS.md).

## 1 · Modos de acceso
| Modo | Para qué | Cómo se activa |
|---|---|---|
| **OIDC (SSO)** | Uso real con personas | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL` |
| **Basic** | POC y demos | `APP_USER` + `APP_PASS` (**hash scrypt**, no texto plano) + `SESSION_SECRET` |
| **Tokens de servicio** | Agentes y pipelines | Se crean en la pestaña Tokens (siempre disponibles junto a los anteriores) |
| **Abierto** | Solo desarrollo local | `ALLOW_ANONYMOUS=true` (en producción exige esa variable explícita) |

**Seguro por defecto:** con `NODE_ENV=production` y sin ninguno de los modos anteriores, el servicio **no arranca** y dice por qué. El modo Basic arranca pero avisa en el log que es para POC.

## 2 · Roles
`lector < agente < solicitante < admin`.
| Acción | lector | agente | solicitante | admin |
|---|:-:|:-:|:-:|:-:|
| Ver pools, asignaciones, reservas | ✔ | ✔ | ✔ | ✔ |
| Reservar (también «Nueva reserva» en la interfaz) y liberar **sus** reservas | | ✔ | ✔ | ✔ |
| **Aprobar** (confirmar) reservas | | solo las suyas, con `aprobado_por` | | ✔ (todas) |
| Asignar directo (sin reserva) | | | | ✔ |
| Liberar asignaciones, confirmar/liberar reservas ajenas | | | | ✔ |
| Tokens, usuarios, auditoría, respaldo e importación | | | | ✔ |
Los usuarios pueden ser `lector`, `solicitante` o `admin`; los tokens, `lector` o `agente`.

**Cómo se decide el rol con SSO** (en orden): correos admin de la configuración (`OIDC_ADMIN_EMAILS`) → rol asignado en la pestaña Usuarios → grupos del proveedor (`OIDC_ADMIN_GROUPS`, `OIDC_REQUESTER_GROUPS`, `OIDC_READER_GROUPS`) → `OIDC_DEFAULT_ROLE` (`lector`).

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
Imagen mínima (Chainguard) fijada por digest, usuario no root (65532), sistema de archivos de solo lectura, `cap_drop: ALL`; en Kubernetes, `NetworkPolicy` y contexto de seguridad estrictos en el chart.

## 8 · Qué hacer ante un incidente
1. Revoca los tokens sospechosos (pestaña Tokens).
2. Revisa la **Auditoría** por fecha y usuario; el `request_id` lleva a los logs.
3. Rota `SESSION_SECRET` (cierra todas las sesiones) y las contraseñas de los roles de base de datos.
4. Más pasos en el [RUNBOOK](ops/RUNBOOK.md). Reporte de vulnerabilidades: [SECURITY.md](../SECURITY.md).
