# IPAM · MVP

Gestión de segmentos de red (IPv4): pools, asignaciones sin solapamiento, sugerencia de segmentos libres e integración con Jira por webhook firmado.

**Stack:** Node 20 + Express · PostgreSQL 16 · Docker Compose.

## Levantar en local
```bash
docker compose up -d --build        # http://localhost:8080
docker compose down -v              # apaga y borra la base (vuelve a los datos de ejemplo)
```
Variables opcionales (archivo `.env` junto al compose): `APP_USER` y `APP_PASS` (activan clave de acceso), `DB_PASSWORD`, `JIRA_WEBHOOK_SECRET`, `PORT`.
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

## Cómo está resuelto lo importante
- **Sin solapamientos, garantizado por la base:** restricción de exclusión GiST (`sin_solapamiento`) sobre `(pool, cidr)`; además un trigger exige que el segmento caiga dentro del pool. Aunque alguien inserte directo en la base, se rechaza.
- **Concurrencia:** las asignaciones de un mismo pool se serializan con un bloqueo de transacción (probado: 20 solicitudes simultáneas → 20 segmentos distintos).
- **Jira → IPAM:** `POST /webhook/jira`, cuerpo `{ticket, ambiente, tipo, mascara, vpc}`, firma `x-hub-signature-256: sha256=HMAC(cuerpo, JIRA_WEBHOOK_SECRET)`. Firma inválida → 401.

## API
| Método | Ruta | |
|---|---|---|
| GET | `/api/health` | salud (abierta) |
| GET | `/api/pools`, `/api/resumen`, `/api/asignaciones`, `/api/eventos` | lecturas |
| GET | `/api/exportar.xlsx` | Excel con todos los segmentos (hoja «Segmentos») y los pools (hoja «Pools») |
| GET | `/api/jira/estado` | si la integración saliente con Jira está activa |
| GET | `/api/pools/:id/libres?mascara=22` | 3 segmentos libres |
| POST | `/api/solicitudes` `{pool, vpc, cidr?, mascara?}` | 201 · 400 inválido · 409 solapamiento (con conflicto y sugeridos) |
| DELETE | `/api/asignaciones/:id` | liberar |
| POST | `/webhook/jira` | entrada desde Jira (firmada) |
| POST | `/api/jira/simular` | simula un ticket para la demo |

## Integración saliente con Jira (desactivada por defecto)
Código en `src/jira.js`. Se activa con `JIRA_ENABLED=true` más `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT` (opcionales: `JIRA_ISSUE_TYPE`=Task, `JIRA_DONE_TRANSITION`=Done).
- Solicitud desde el panel → crea el ticket en Jira y guarda su clave real en la asignación.
- Ticket que llega por webhook → comenta el rango en el ticket y lo pasa a la transición final.
- Si Jira falla, la asignación se mantiene y queda un evento `jira_error`. Sin activar, todo funciona como antes (tickets `NET-xxx` simulados).
- Aún no probada contra un Jira real. Pendiente para Helm: pasar estas variables al Secret/values del chart.

## Alcance del MVP (lo que NO está)
- Con la integración desactivada, los números de ticket (`NET-xxx`) los genera el IPAM.
- Solo IPv4, un único usuario (Basic Auth), sin roles ni historial de cambios por usuario.
- Los 6 pools y 12 asignaciones son datos de ejemplo.

## Guion de demo (5 min)
1. **Pools:** estado y uso de cada pool.
2. **Solicitar:** `gke-pods-prod` + `10.64.8.0/22` → solapamiento con NET-142, y sugeridos; «Usar» → asignado con ticket.
3. **Solicitar sin CIDR** (solo máscara) → asigna el primer libre.
4. **Jira:** «Enviar webhook» → se ve el evento recibido, la asignación y la actualización del ticket.
5. **Asignaciones:** aparecen con origen `panel` / `jira`; «Liberar» devuelve el espacio.
