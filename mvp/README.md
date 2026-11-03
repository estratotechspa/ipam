# IPAM · MVP

## Lee esto si quieres…
| Quiero… | Documento |
|---|---|
| Entender los términos | [GLOSARIO](../docs/GLOSARIO.md) |
| **Aprender a usar el IPAM** (paso a paso, con capturas) | [MANUAL-DE-USUARIO](../docs/MANUAL-DE-USUARIO.md) |
| **Consultar cada pestaña** (referencia) | [MANUAL-DE-USO](../docs/MANUAL-DE-USO.md) |
| Entender cómo está construido y por qué | [ARQUITECTURA](../docs/ARQUITECTURA.md) y los [ADR](../docs/adr/) |
| Llamar a la API o integrar un agente | [API-Y-AGENTES](../docs/API-Y-AGENTES.md) y `/api/v1/openapi.json` |
| Entender el YAML de redes del MVP | [CONTRATO-YAML-REDES](../docs/CONTRATO-YAML-REDES.md) |
| Configurar roles, tokens y seguridad | [ACCESO-Y-SEGURIDAD](../docs/ACCESO-Y-SEGURIDAD.md) |
| Ver todas las variables | [CONFIGURACION](../docs/CONFIGURACION.md) |
| Desplegarlo (Docker, Kubernetes, nubes) | [DESPLIEGUE](../docs/ops/DESPLIEGUE.md) y [PORTABILIDAD](../docs/PORTABILIDAD.md) |
| Levantar el POC en Render + Supabase | [POC-RENDER-SUPABASE](../docs/ops/POC-RENDER-SUPABASE.md) |
| Operarlo y resolver fallas | [RUNBOOK](../docs/ops/RUNBOOK.md) y [OBSERVABILIDAD](../docs/ops/OBSERVABILIDAD.md) |
| Respaldar y recuperar | [RESPALDO-Y-RECUPERACION](../docs/ops/RESPALDO-Y-RECUPERACION.md) y [OPERACION](../docs/OPERACION.md) |
| Cambiar de hosting o de nube | [MIGRACION](../docs/ops/MIGRACION.md) |
| Pasar de GitHub a GitLab / pipelines | [MIGRAR-A-GITLAB](../docs/ops/MIGRAR-A-GITLAB.md) y [ops/gitlab](../docs/ops/gitlab/README.md) |
| Aplicar buenas prácticas (human-in-the-loop) | [BUENAS-PRACTICAS](../docs/BUENAS-PRACTICAS.md) |
| Saber qué no hace | [LIMITACIONES](../docs/LIMITACIONES.md) y [ANALISIS-IPAM-COMERCIAL](../docs/ANALISIS-IPAM-COMERCIAL.md) |
| Revisar la seguridad del código | [MODELO-DE-AMENAZAS](../docs/MODELO-DE-AMENAZAS.md) y [CALIDAD-Y-SEGURIDAD-DEL-CODIGO](../docs/CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md) |
| Contribuir (incluye «cómo agregar un adaptador») | [CONTRIBUIR](../docs/CONTRIBUIR.md) |
| Ver los cambios por versión | [CHANGELOG](../CHANGELOG.md) |

Gestión de segmentos de red (IPv4): pools, segmentos (reservas y asignaciones) sin solapamiento, sugerencia de segmentos libres, direcciones IP fijas, tokens para agentes e integración con Jira por webhook firmado.

**Stack:** Node 22 + Express 5 · PostgreSQL 14–17 · Docker.

## Levantar en local
```bash
docker compose up -d --build        # http://localhost:8080
docker compose down -v              # apaga y borra la base (vuelve a los datos de ejemplo)
```
Variables opcionales (archivo `.env` junto al compose): `APP_USER` y `APP_PASS` (clave de acceso) o `OIDC_*` + `PUBLIC_URL` + `SESSION_SECRET` (ver «Acceso, roles y auditoría»), `DB_PASSWORD`, `JIRA_WEBHOOK_SECRET`, `PORT`.
Pruebas unitarias: `npm test`.

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
Tres modos, según la configuración: **OIDC** (`OIDC_ISSUER`), **Basic Auth** de un solo usuario (`APP_USER` + `APP_PASS`, solo demos) o **abierto** (demo local; la interfaz lo avisa).

**Inicio de sesión con Google Workspace** (cualquier proveedor OpenID Connect funciona igual cambiando `issuer`):
1. En Google Cloud → *APIs y servicios → Credenciales* → *ID de cliente de OAuth* (aplicación web). URI de redirección autorizado: `<PUBLIC_URL>/auth/callback`.
2. Helm: `auth.oidc.issuer=https://accounts.google.com`, `auth.oidc.clientId=…`, `secrets.oidcClientSecret=…`, `config.publicUrl=https://ipam.…`, `auth.oidc.allowedDomains=empresa.cl`, `auth.oidc.adminEmails=quien@empresa.cl`.
3. Microsoft Entra: `issuer=https://login.microsoftonline.com/<tenant>/v2.0` y, si usan grupos, `scopes="openid email profile"` + `groupsClaim`/`adminGroups`.

| Rol | Puede |
|---|---|
| `lector` | ver pools, segmentos, direcciones IP y exportar a Excel |
| `agente` | + reservar segmentos, confirmar y liberar **sus** reservas, registrar IP (es el rol de los tokens de servicio) |
| `solicitante` | + lo del agente; simular tickets de Jira |
| `admin` | + asignar y liberar segmentos, administrar pools, tokens y usuarios, ver auditoría y eventos, respaldo JSON |

Detalle por operación en [ACCESO-Y-SEGURIDAD](../docs/ACCESO-Y-SEGURIDAD.md).

El rol sale de: correos admin de la configuración (siempre) → rol asignado en la pestaña *Usuarios* → grupos del proveedor → `defaultRole` (`lector`; `ninguno` = solo entran los mapeados). La sesión es una cookie firmada de 4 h (`SESSION_HORAS`) sin estado en el servidor (sirve con varias réplicas); el rol y la existencia de la persona se revalidan en la base cada 5 min (`SESSION_REVALIDAR_SEG`), así que una baja o un cambio de rol rige en ese tiempo; cerrar sesión borra la cookie local, no cierra la sesión en Google. Los cambios desde el navegador exigen la cabecera `X-Requested-With: ipam` (defensa CSRF). Todo inicio/cierre de sesión, asignación, liberación, exportación y cambio de rol queda en la tabla `auditoria` (pestaña *Auditoría*).

## Respaldos y exposición
- **Respaldos incrementales a GCS** (`postgres.backup.*`): completo semanal + incremental diario + WAL continuo (recuperación a cualquier instante), retención de 4 completos y prueba de restauración mensual. Imagen `mvp/postgres` (PostgreSQL + pgBackRest). Pasos, restauración y qué vigilar: **`docs/OPERACION.md`**.
- **URL interna del cliente** (`ingress.*`, `httpRoute.*`, `config.publicUrl`): ver el mismo documento, que incluye el paso de la POC al tenant del cliente.

## Marca y dominio configurables
Nada de «EstratoTech» está escrito en el código ni en la imagen: nombre, colores, logo y URL se cambian por configuración.
- Variables: `BRAND_NAME`, `BRAND_SUBTITLE`, `BRAND_FOOTER`, `BRAND_COLOR` (botones), `BRAND_COLOR_TOP` (barra), `BRAND_COLOR_ACCENT`, `BRAND_LOGO_FILE` (ruta de un png/jpg/webp/svg ≤ 512 KB). Colores solo en formato `#rrggbb`.
- Helm: `branding.*` (el logo va en base64: `--set-string branding.logo="$(base64 < logo.png | tr -d '\n')"`).
- Dominio: `config.publicUrl` (o `ingress.host`); es la base del login y de los enlaces. POC: `ipam.estratotech.cl`; luego, el del cliente (p. ej. `ipam.cliente.interno.cl`) cambiando solo ese valor y el registro de retorno en el proveedor OIDC.

## Llevarse el IPAM a otra infraestructura
- **Respaldo lógico:** `GET /api/v1/exportar.json` (admin; botón «Respaldo JSON») entrega pools, asignaciones y roles asignados.
- **Restauración:** `POST /api/v1/importar` con ese JSON (admin). Es todo o nada: si algún segmento se solapa con otro, se rechaza completo (409) y no se importa nada. Los pools que ya existen no se tocan y las asignaciones repetidas se omiten, así que se puede repetir sin duplicar.
  `curl -u … -H 'X-Requested-With: ipam' -H 'Content-Type: application/json' --data @ipam-respaldo.json https://<host>/api/v1/importar`
- La contraseña de la base, los secretos de OIDC/Jira y la marca viven en Secret/ConfigMap/values: se reinstala el chart en el nuevo clúster con otros valores y se importa el JSON.

## Seguridad del contenedor y del chart
- **Imagen:** dos etapas; runtime `gcr.io/distroless/nodejs22-debian13` (Node 22, la versión con la que se prueba todo) fijado por digest (sin shell ni gestor de paquetes; Trivy bloquea CRITICAL/HIGH con parche en el CI). Usuario `65532`, sistema de archivos de solo lectura, sin capacidades Linux.
- **Imagen propia del cliente:** `docker build --build-arg BASE_IMAGE=<su-imagen-node> --build-arg BUILD_IMAGE=<su-imagen-node> .` (Node ≥ 20 en el PATH, usuario no root).
- **Chart:** `seccomp RuntimeDefault`, ServiceAccount propia sin token montado, `NetworkPolicy` (`networkPolicy.*`; `ingressFrom` para limitar quién llega a la app), Postgres y Job con filesystem de solo lectura y límites de recursos.
- **Cabeceras HTTP:** `helmet` con CSP estricta (`script-src 'self'`). Detrás de un ingress: `TRUST_PROXY=1`; con acceso solo por HTTPS: `HSTS=true`.
- **Cadena de suministro:** `publicar.yml` publica en GHCR con SBOM y atestación. Pendiente: firma de imágenes y TLS de extremo a extremo → `docs/DEUDA-TECNICA.md`.

## Cómo está resuelto lo importante
- **Sin solapamientos, garantizado por la base:** restricción de exclusión GiST (`sin_solapamiento`) sobre `(pool, cidr)`; además un trigger exige que el segmento caiga dentro del pool. Aunque alguien inserte directo en la base, se rechaza.
- **Concurrencia:** las asignaciones de un mismo pool se serializan con un bloqueo de transacción (probado: 20 solicitudes simultáneas → 20 segmentos distintos).
- **Jira → IPAM:** `POST /webhook/jira`, cuerpo `{ticket, ambiente, tipo, mascara, vpc}` con dos cabeceras: `x-ipam-timestamp` (segundos desde 1970, UTC) y `x-hub-signature-256: sha256=HMAC-SHA256(JIRA_WEBHOOK_SECRET, "<timestamp>.<cuerpo>")`. La firma cubre la hora: se rechaza (`401`) lo firmado hace más de 5 min o en el futuro. Un reenvío dentro de la ventana es inofensivo (idempotente por ticket). **Cambio incompatible:** quien firmaba solo el cuerpo debe añadir el timestamp. Ejemplo:
  `ts=$(date +%s); sig=$(printf '%s.%s' "$ts" "$cuerpo" | openssl dgst -sha256 -hmac "$SECRETO" | sed 's/^.* //'); curl -H "x-ipam-timestamp: $ts" -H "x-hub-signature-256: sha256=$sig" -H 'Content-Type: application/json' -d "$cuerpo" https://<host>/webhook/jira`

## API
| Método | Ruta | |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/api/health` | vivo · listo (base y versión de esquema) · salud (abiertas) |
| GET | `/api/v1/pools`, `/api/v1/resumen`, `/api/v1/asignaciones` | lecturas (`asignaciones` pagina: `limit`, `offset`, `X-Total-Count`) |
| GET | `/api/v1/eventos` · `/api/v1/auditoria` · `/api/v1/usuarios` | eventos · bitácora · usuarios y roles (**solo admin**) |
| GET | `/api/v1/me` | sesión actual |
| POST · PATCH · DELETE | `/api/v1/pools` · `/api/v1/pools/:id` | crear, editar y eliminar pools (admin; solo se elimina uno sin segmentos ni IPs) |
| POST · GET · DELETE | `/api/v1/tokens` | tokens de servicio con su `alcance` (admin) |
| POST · GET · DELETE | `/api/v1/reservas` · `/api/v1/reservas/:id[/confirmar]` | reservas tentativas (agente) |
| GET · POST · PATCH · DELETE | `/api/v1/direcciones` | IPs fijas dentro de un segmento |
| GET · POST | `/api/v1/exportar.json` · `/api/v1/importar` | respaldo lógico completo · restauración (admin) |
| GET | `/api/config` · `/brand.css` · `/brand/logo` | marca (abiertos) |
| GET | `/api/v1/exportar.xlsx` | Excel con todos los segmentos (hoja «Segmentos») y los pools (hoja «Pools») |
| GET | `/api/v1/jira/estado` | si la integración saliente con Jira está activa |
| GET | `/api/v1/pools/:id/libres?mascara=22` | 3 segmentos libres |
| POST | `/api/v1/solicitudes` `{pool, vpc?, cidr?, mascara?, proyecto?, subred?, vlan?, …}` | asigna de inmediato (admin): 201 · 400 inválido · 409 solapamiento (con conflicto y sugeridos) |
| DELETE | `/api/v1/asignaciones/:id` | liberar |
| POST | `/webhook/jira` | entrada desde Jira (firmada) |
| POST | `/api/v1/jira/simular` | simula un ticket para la demo. Solo fuera de producción o con `ENABLE_SIMULADOR=true`; si no, 404 |

Todo lo anterior vive solo bajo `/api/v1` (los alias sin versión se retiraron). Referencia completa: `/api/v1/openapi.json` y [API-Y-AGENTES](../docs/API-Y-AGENTES.md). Con `MODULOS_DESACTIVADOS` se apagan módulos enteros (`jira`, `importacion`, `direcciones`, `respaldo`, `excel`): responden 404 `modulo_desactivado`.

## Integración saliente con Jira (desactivada por defecto)
Código en `src/aplicacion/jira.js` y `src/adaptadores/tickets/jira.js`. Se activa con `JIRA_ENABLED=true` más `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT` (opcionales: `JIRA_ISSUE_TYPE`=Task, `JIRA_DONE_TRANSITION`=Done).
- Solicitud desde el panel → crea el ticket en Jira y guarda su clave real en la asignación.
- Ticket que llega por webhook → comenta el rango en el ticket y lo pasa a la transición final.
- Si Jira falla, la asignación se mantiene y queda un evento `jira_error`. Sin activar, todo funciona como antes (tickets `NET-xxx` simulados).
- La sincronización corre en segundo plano con reintentos (`JIRA_REINTENTOS`, `JIRA_REINTENTO_MS`); el resultado queda en `eventos`.
- Aún no probada contra un Jira real. Pendiente para Helm: pasar estas variables al Secret/values del chart.

## Alcance del MVP (lo que NO está)
- Con la integración desactivada, los números de ticket (`NET-xxx`) los genera el IPAM.
- Solo IPv4. Las sesiones OIDC se revalidan cada 5 min (`SESSION_REVALIDAR_SEG`): una baja o un cambio de rol rige en ese tiempo, no al instante en todas las réplicas; no hay «cerrar sesión en todos los dispositivos». El rol que dan los grupos del proveedor se fija al iniciar sesión.
- No descubre redes existentes: solo conoce lo que se registra en él (ver [LIMITACIONES](../docs/LIMITACIONES.md)).
- Los 6 pools y 12 asignaciones son datos de ejemplo.

## Guion de demo (5 min)
1. **Pools:** estado y uso de cada pool.
2. **Segmentos → Nuevo segmento** (admin, casilla «Es una reserva» desmarcada → «Asignar ahora»): `gke-pods-prod` + `10.64.8.0/22` → solapamiento con NET-142, y sugeridos; «Usar» → asignado con ticket.
3. **Nuevo segmento sin CIDR** (solo máscara; proyecto, VPC, subred/VLAN opcionales) → asigna el primer libre; clic en su ID → ficha con detalle e historial.
3b. **Direcciones IP:** en la ficha del segmento → «Registrar IP fija» (`rtr-core-01` · `Gi0/1` · gateway); en la pestaña Direcciones IP, buscar por el equipo.
3c. **API:** enlace «API» → `/api.html`, «Try it out» en `GET /api/v1/pools`.
4. **Jira:** «Enviar webhook» → se ve el evento recibido, la asignación y la actualización del ticket.
5. **Segmentos:** aparecen con origen `panel` / `jira`; «Liberar» (pide escribir el CIDR) devuelve el espacio. Las reservas pendientes están en la vista «Reservados».
