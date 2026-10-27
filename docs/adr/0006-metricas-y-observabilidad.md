# ADR 0006 · Métricas y observabilidad portables

- **Estado:** aceptada · **Fecha:** 2026-10-21 · **Relacionada con:** [0008](0008-portabilidad-entre-nubes.md)

## Contexto
Hay que poder vigilar el IPAM (¿se llena un pool?, ¿hay errores?, ¿corre el barredor?) en Render, Google Cloud, AWS, Azure o un servidor propio, sin atar el código a una herramienta.

## Decisión
- **Métricas en formato Prometheus** (`GET /metrics`) y **trazas OpenTelemetry (OTLP)**: dos estándares que casi todo backend entiende. Logs JSON a stdout.
- `/metrics` **nace cerrado**: sin `METRICS_TOKEN` ni `METRICS_ALLOW_CIDRS` responde 404 (las métricas revelan datos de operación). El token de métricas es distinto de los tokens de servicio.
- **Medidores desde la base de datos, contadores por réplica.** Reservas, tokens, utilización de pools y último barrido se calculan consultando la base: son correctos con 1 o N réplicas y no se reinician al desplegar.
  Los contadores (peticiones, rechazos, límites excedidos, expiraciones) los lleva cada réplica y el recolector los suma.
- **Etiquetas acotadas:** `ruta` es la plantilla (`/api/v1/reservas/:id`), nunca la ruta real (evita explosión de cardinalidad y no filtra identificadores).
- **Las alertas y el dashboard viven fuera del código**, en `docs/ops/`: reglas `PrometheusRule` y de Prometheus para cualquier nube, y JSON/OpenTofu de Cloud Monitoring en `docs/ops/alertas/cloud-monitoring/`
  y `docs/ops/gcp/`. Se **generan desde una sola fuente** (`scripts/ci/generar-alertas.js`) y una prueba comprueba que no se desvíen y que solo citen métricas que existen.
- En Kubernetes/GKE el chart puede crear un `PodMonitoring` de Google Managed Prometheus, **solo** activado en `values-gke.yaml` (el chart genérico no sabe de ningún proveedor).

## Consecuencias
- (+) Cambiar de nube = cambiar el recolector y las reglas importadas, no el IPAM.
- (−) El POC en Render (plan gratuito, el servicio duerme) **no tiene recolector**: no hay métricas mientras duerme. Las alertas son para cuando exista uno.
- (−) `ipam_reservas_total{estado}` es un medidor con nombre de contador: se mantuvo el nombre acordado y se explica en la ayuda de la métrica.
