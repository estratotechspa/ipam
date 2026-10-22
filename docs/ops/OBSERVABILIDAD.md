# Observabilidad: métricas, alertas, dashboard y trazas

El IPAM expone **métricas Prometheus** (`/metrics`), **logs JSON** y **trazas OpenTelemetry** (apagadas por defecto). Funciona con cualquier backend; lo específico de cada nube
vive en `docs/ops/<nube>/`, nunca en el código.

## `/metrics`
Protegido, o deshabilitado: sin `METRICS_TOKEN` ni `METRICS_ALLOW_CIDRS` responde **404**.

| Variable | Qué hace |
|---|---|
| `METRICS_TOKEN` | Quien lea debe enviar `Authorization: Bearer <METRICS_TOKEN>`. Es un secreto distinto de los tokens de servicio (uno no sirve para el otro). |
| `METRICS_ALLOW_CIDRS` | Redes IPv4 desde las que se puede leer (p. ej. `10.0.0.0/8`). Con `TRUST_PROXY` se usa la IP real del cliente. Si defines las dos, deben cumplirse las dos. |

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://ipam.ejemplo.interno/metrics | head
```
Ejemplo de configuración de recolección con Prometheus:
```yaml
scrape_configs:
  - job_name: ipam
    metrics_path: /metrics
    authorization: { type: Bearer, credentials_file: /etc/prometheus/ipam-metrics-token }
    static_configs: [{ targets: ['ipam.ejemplo.interno:443'] }]
    scheme: https
```

## Métricas
| Métrica | Tipo | Qué dice |
|---|---|---|
| `ipam_http_requests_total{ruta,metodo,codigo}` | contador | Peticiones. `ruta` es la **plantilla** (`/api/v1/reservas/:id`), no la ruta real |
| `ipam_http_request_duration_seconds{ruta,metodo}` | histograma | Latencia |
| `ipam_reservas_activas` | medidor | Reservas vigentes ahora |
| `ipam_reservas_total{estado}` | medidor | Reservas por estado (se calcula desde la base de datos; el nombre `_total` es el acordado) |
| `ipam_reservas_expiradas_total` | contador | Expiraciones que marcó esta réplica |
| `ipam_pool_utilizacion_ratio{pool}` | medidor | 0 a 1: asignaciones + reservas vigentes sobre el tamaño del pool |
| `ipam_tokens_activos`, `ipam_tokens_por_vencer` | medidor | Tokens activos y los que vencen en menos de 7 días |
| `ipam_auth_rechazos_total{motivo}` | contador | `token_desconocido`, `token_vencido`, `token_revocado`, `token_formato`, `credenciales_basic`, `sesion_invalida`, `csrf`, `fuerza_bruta`, `metrics_token`, `metrics_red` |
| `ipam_rate_limit_excedido_total` | contador | Peticiones rechazadas con 429 por límite |
| `ipam_barredor_ultima_ejecucion_timestamp` | medidor | Última ejecución del barredor en **cualquier** réplica (0 si nunca) |
| `ipam_db_up` | medidor | 1 si la base responde |

Los **medidores** salen de la base de datos (correctos con cualquier número de réplicas y no se reinician al desplegar; se leen con una caché de 5 s).
Los **contadores** son por réplica: Prometheus los suma. Además se exponen las métricas estándar de Node (`process_*`, `nodejs_*`).

## Alertas y dashboard
- Reglas listas para copiar: [`alertas/`](alertas/) — `prometheusrule.yaml` (Prometheus Operator, kube-prometheus-stack, GMP), `reglas-prometheus.yml` (Prometheus a secas) y `cloud-monitoring/` (JSON y OpenTofu/Terraform).
- Dashboard de Cloud Monitoring: [`gcp/dashboard-ipam.json`](gcp/dashboard-ipam.json) (cómo importarlo: [`gcp/README.md`](gcp/README.md)).
- Alertas incluidas: pool > 80 % y > 90 %, `ipam_db_up == 0`, barredor detenido > 5 min (solo si el servicio está siempre encendido), picos de 401 y de 429, tokens por vencer y tasa de 5xx.
- Se generan desde `scripts/ci/generar-alertas.js`; `scripts/ci/validar-alertas.sh` las valida con `jq`, `promtool` y `tofu validate`.

**El POC en Render + plan gratuito no tiene recolector** y el servicio duerme: `/metrics` no se puede recolectar mientras duerme. Las alertas son para cuando exista un recolector.

## Logs y trazas
- **Logs:** una línea JSON por evento a stdout, con `request_id`, `actor`, `ruta`, `estado`, `duracion_ms` y `trace_id` si existe. Las credenciales se redactan automáticamente. Cualquier plataforma de logs los entiende (Cloud Logging, CloudWatch, Loki…).
- **Correlación:** el `X-Request-Id` (aceptado o generado) viaja a logs, auditoría y errores; con él se encuentra todo lo de una petición.
- **Trazas (OpenTelemetry):** apagadas. Para activarlas: `OTEL_TRACES_EXPORTER=otlp` y `OTEL_EXPORTER_OTLP_ENDPOINT=http://colector:4318` (más `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG` y `OTEL_EXPORTER_OTLP_HEADERS` si hacen falta). Una traza por petición; se continúa el `traceparent` entrante; nunca se registran cuerpos, cabeceras ni la query string.
