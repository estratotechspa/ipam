# Observabilidad en Google Cloud (dashboard y alertas)

> Todo esto es **específico de Google Cloud** y por eso vive aquí y no en el código del IPAM. Las mismas reglas para otras nubes están en
> [`../alertas/`](../alertas/) como `PrometheusRule` / archivo de reglas de Prometheus.
> **No se probó contra una cuenta real**: los JSON y el HCL se validaron con `jq` y `tofu validate`; los resultados de importarlos dependen de tu proyecto.

## Qué necesitas antes
1. Que las métricas de `/metrics` lleguen a Cloud Monitoring: con **Google Managed Prometheus** (en GKE, el chart crea el `PodMonitoring` si usas `values-gke.yaml`) o con un recolector propio.
2. `METRICS_TOKEN` configurado (o `METRICS_ALLOW_CIDRS`): sin eso `/metrics` está deshabilitado (404).
3. **Cloud Run con escalado a cero y el POC de Render no sirven para esto**: mientras el servicio duerme no hay nada que recolectar.

## Importar el dashboard
```bash
gcloud monitoring dashboards create --config-from-file=docs/ops/gcp/dashboard-ipam.json --project PROYECTO
```
Paneles: utilización por pool, reservas por estado y vigentes, latencia p95 por ruta, peticiones por código, errores 5xx, rechazos de autenticación, base de datos arriba, segundos desde el último barrido y tokens.

## Importar las alertas
Una política por archivo (gcloud importa de a una). Primero crea un canal de notificación y pon su id en `notificationChannels`:
```bash
for f in docs/ops/alertas/cloud-monitoring/*.json; do gcloud alpha monitoring policies create --policy-from-file="$f" --project PROYECTO; done
```
O con OpenTofu/Terraform (compatible con ambos): `docs/ops/alertas/cloud-monitoring/` es un mini módulo.
```bash
cd docs/ops/alertas/cloud-monitoring
tofu init && tofu plan -var proyecto=PROYECTO -var 'canales_de_notificacion=["projects/PROYECTO/notificationChannels/123"]'
```
Las alertas se **generan** desde `scripts/ci/generar-alertas.js` (una sola fuente); si cambias umbrales, edita ese archivo y ejecuta `node scripts/ci/generar-alertas.js`.
Qué hacer cuando suena cada alerta: [`../RUNBOOK.md`](../RUNBOOK.md).
