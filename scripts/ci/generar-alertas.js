#!/usr/bin/env node
'use strict';
// Genera TODAS las alertas desde una sola fuente (esta lista), para que no se desvíen entre formatos:
//   docs/ops/alertas/cloud-monitoring/*.json        Cloud Monitoring (una política por archivo; gcloud importa de a una)
//   docs/ops/alertas/cloud-monitoring/alertas.tf    OpenTofu / Terraform (google_monitoring_alert_policy)
//   docs/ops/alertas/prometheusrule.yaml            PrometheusRule (Prometheus Operator, GMP, kube-prometheus-stack)
//   docs/ops/alertas/reglas-prometheus.yml          el mismo contenido como archivo de reglas de Prometheus (promtool)
//   docs/ops/gcp/dashboard-ipam.json                dashboard de Cloud Monitoring
// Uso: node scripts/ci/generar-alertas.js            (escribe)      ·      node scripts/ci/generar-alertas.js --texto   (devuelve {ruta: contenido} en JSON, sin escribir)
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const slug = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').toLowerCase();

/** Fuente única. `duracion` en segundos. Los umbrales de este archivo son el punto de partida: ajústalos a tu operación. */
const ALERTAS = [
  { id: 'IpamPoolSobre80', nombre: 'IPAM · pool sobre 80 % de utilización', query: 'ipam_pool_utilizacion_ratio > 0.8', duracion: 600, severidad: 'warning',
    resumen: 'El pool {{ $labels.pool }} está sobre el 80 % (asignaciones + reservas vigentes).',
    doc: 'Un pool se está llenando. Revisa `docs/ops/RUNBOOK.md` → «Un pool está lleno»: libera rangos que ya no se usen, revisa reservas colgadas o planifica un pool nuevo.' },
  { id: 'IpamPoolSobre90', nombre: 'IPAM · pool sobre 90 % de utilización', query: 'ipam_pool_utilizacion_ratio > 0.9', duracion: 300, severidad: 'critical',
    resumen: 'El pool {{ $labels.pool }} está sobre el 90 %: quedan pocos rangos.',
    doc: 'Casi sin espacio. Las nuevas reservas de ese pool empezarán a fallar con 409 `sin_espacio`. Ver `docs/ops/RUNBOOK.md` → «Un pool está lleno».' },
  { id: 'IpamBaseDeDatosCaida', nombre: 'IPAM · la base de datos no responde', query: 'ipam_db_up == 0', duracion: 120, severidad: 'critical',
    resumen: 'El IPAM no logra consultar su base de datos.',
    doc: 'El servicio sigue vivo pero `/readyz` da 503. Ver `docs/ops/RUNBOOK.md` → «La base de datos está caída».' },
  { id: 'IpamBarredorDetenido', nombre: 'IPAM · el barredor no corre hace más de 5 minutos', query: 'time() - ipam_barredor_ultima_ejecucion_timestamp > 300', duracion: 60, severidad: 'warning',
    resumen: 'Ninguna réplica ejecuta el barredor hace más de 5 minutos.',
    doc: 'Solo tiene sentido si el servicio está SIEMPRE encendido (no en planes gratuitos que duermen). La corrección no depende del barredor (la expiración es perezosa), pero las reservas vencidas no se limpian. Ver `docs/ops/RUNBOOK.md` → «El barredor no corre».' },
  { id: 'IpamPicoDe401', nombre: 'IPAM · pico de respuestas 401 (no autenticado)', query: 'sum(rate(ipam_http_requests_total{codigo="401"}[5m])) > 0.5', duracion: 300, severidad: 'warning',
    resumen: 'Más de 0,5 respuestas 401 por segundo sostenidas.',
    doc: 'Puede ser un token vencido o revocado en un agente, o un intento de fuerza bruta. Revisa la auditoría (`token_rechazado`). Ver `docs/ops/RUNBOOK.md` → «Hay muchos 401».' },
  { id: 'IpamPicoDe429', nombre: 'IPAM · pico de respuestas 429 (límite excedido)', query: 'sum(rate(ipam_http_requests_total{codigo="429"}[5m])) > 0.2', duracion: 300, severidad: 'warning',
    resumen: 'Se están rechazando peticiones por límite o por cuota de reservas.',
    doc: 'Un agente con un bucle roto o una cuota demasiado baja. Ver `docs/ops/RUNBOOK.md` → «Hay muchos 429».' },
  { id: 'IpamTokenPorVencer', nombre: 'IPAM · hay tokens que vencen en menos de 7 días', query: 'ipam_tokens_por_vencer > 0', duracion: 3600, severidad: 'warning',
    resumen: 'Hay {{ $value }} token(s) de servicio por vencer.',
    doc: 'Rota el token: crea uno nuevo, actualiza el agente y revoca el anterior (ver `docs/ACCESO-Y-SEGURIDAD.md`).' },
  { id: 'IpamTasaDe5xx', nombre: 'IPAM · más de 5 % de errores 5xx', query: 'sum(rate(ipam_http_requests_total{codigo=~"5.."}[5m])) / sum(rate(ipam_http_requests_total[5m])) > 0.05 and sum(rate(ipam_http_requests_total[5m])) > 0.05', duracion: 300, severidad: 'critical',
    resumen: 'Más del 5 % de las peticiones terminan en error 5xx.',
    doc: 'Errores internos. Busca el `request_id` de una respuesta 500 en los logs. Ver `docs/ops/RUNBOOK.md`.' },
];

// ---------- Cloud Monitoring (JSON) ----------
function politica(a) {
  return {
    displayName: a.nombre,
    documentation: { content: `${a.doc}\n\nMétrica de origen: expresión PromQL \`${a.query}\`.`, mimeType: 'text/markdown' },
    userLabels: { servicio: 'ipam', severidad: a.severidad },
    conditions: [{
      displayName: a.nombre,
      conditionPrometheusQueryLanguage: { query: a.query, duration: `${a.duracion}s`, evaluationInterval: '60s', alertRule: a.id, labels: { severidad: a.severidad } },
    }],
    combiner: 'OR',
    enabled: true,
    alertStrategy: { autoClose: '1800s' },
    notificationChannels: [],
  };
}

// ---------- HCL ----------
const hcl = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$\{/g, '$${').replace(/%\{/g, '%%{');
function tf() {
  const filas = ALERTAS.map((a) => `    ${slug(a.id).replace(/-/g, '_')} = {
      nombre    = "${hcl(a.nombre)}"
      query     = "${hcl(a.query)}"
      duracion  = "${a.duracion}s"
      severidad = "${a.severidad}"
      alerta    = "${a.id}"
      doc       = "${hcl(a.doc)}"
    }`).join('\n');
  return `# Alertas del IPAM para Cloud Monitoring (OpenTofu / Terraform). GENERADO por scripts/ci/generar-alertas.js: no lo edites a mano.
# Necesitan que las métricas de /metrics lleguen a Cloud Monitoring (Google Managed Prometheus con el PodMonitoring de values-gke.yaml, o un recolector propio).
# NO validado contra una cuenta real: se comprobó la sintaxis con \`tofu validate\`.
locals {
  alertas = {
${filas}
  }
}

resource "google_monitoring_alert_policy" "ipam" {
  for_each     = local.alertas
  display_name = each.value.nombre
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = each.value.nombre
    condition_prometheus_query_language {
      query               = each.value.query
      duration            = each.value.duracion
      evaluation_interval = "60s"
      alert_rule          = each.value.alerta
      labels = {
        severidad = each.value.severidad
      }
    }
  }

  documentation {
    content   = "\${each.value.doc}\\n\\nExpresión PromQL: \`\${each.value.query}\`."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "1800s"
  }

  notification_channels = var.canales_de_notificacion
  user_labels = {
    servicio  = "ipam"
    severidad = each.value.severidad
  }
}
`;
}
const TF_VARIABLES = `variable "proyecto" {
  description = "Proyecto de Google Cloud donde viven las alertas."
  type        = string
}

variable "canales_de_notificacion" {
  description = "IDs completos de canales de notificación de Cloud Monitoring (correo, Slack, PagerDuty…). Vacío = las alertas se crean sin avisar a nadie."
  type        = list(string)
  default     = []
}
`;
const TF_VERSIONS = `terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

provider "google" {
  project = var.proyecto
}
`;

// ---------- Prometheus ----------
const yamlTxt = (s) => JSON.stringify(s); // JSON es YAML válido para textos
function reglasYaml(sangria) {
  const pad = ' '.repeat(sangria);
  return ALERTAS.map((a) => `${pad}- alert: ${a.id}
${pad}  expr: ${yamlTxt(a.query)}
${pad}  for: ${Math.round(a.duracion / 60)}m
${pad}  labels:
${pad}    severidad: ${a.severidad}
${pad}    servicio: ipam
${pad}  annotations:
${pad}    summary: ${yamlTxt(a.resumen)}
${pad}    description: ${yamlTxt(a.doc)}
${pad}    runbook_url: "docs/ops/RUNBOOK.md"`).join('\n');
}
const ENCABEZADO = '# GENERADO por scripts/ci/generar-alertas.js: no lo edites a mano (edita la lista de ese script y vuelve a ejecutarlo).\n';
function prometheusRule() {
  return `${ENCABEZADO}# PrometheusRule (CRD de Prometheus Operator; también lo entienden kube-prometheus-stack y Google Managed Prometheus con su operador).
# Aplicar:  kubectl apply -f prometheusrule.yaml -n <namespace del IPAM>   (ajusta la etiqueta \`release\` al selector de tu Prometheus)
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ipam
  labels:
    app.kubernetes.io/name: ipam
    release: prometheus
spec:
  groups:
    - name: ipam
      interval: 1m
      rules:
${reglasYaml(8)}
`;
}
function reglasPlanas() {
  return `${ENCABEZADO}# Mismas reglas como archivo de Prometheus (rule_files:). Validar:  promtool check rules reglas-prometheus.yml
groups:
  - name: ipam
    interval: 1m
    rules:
${reglasYaml(6)}
`;
}

// ---------- Dashboard de Cloud Monitoring ----------
function widgetLineas(titulo, promql, { x, y, ancho = 6, alto = 4, unidad } = {}) {
  return { xPos: x, yPos: y, width: ancho, height: alto, widget: { title: titulo, xyChart: {
    dataSets: [{ timeSeriesQuery: { prometheusQuery: promql }, plotType: 'LINE' }],
    yAxis: { scale: 'LINEAR', ...(unidad ? { label: unidad } : {}) },
  } } };
}
function dashboard() {
  return {
    displayName: 'IPAM · operación',
    labels: { servicio: 'ipam' },
    mosaicLayout: { columns: 12, tiles: [
      widgetLineas('Utilización por pool (0 a 1)', 'ipam_pool_utilizacion_ratio', { x: 0, y: 0, ancho: 12 }),
      widgetLineas('Reservas por estado', 'ipam_reservas_total', { x: 0, y: 4 }),
      widgetLineas('Reservas vigentes', 'ipam_reservas_activas', { x: 6, y: 4 }),
      widgetLineas('Latencia p95 por ruta (s)', 'histogram_quantile(0.95, sum by (le, ruta) (rate(ipam_http_request_duration_seconds_bucket[5m])))', { x: 0, y: 8, unidad: 's' }),
      widgetLineas('Peticiones por segundo y código', 'sum by (codigo) (rate(ipam_http_requests_total[5m]))', { x: 6, y: 8 }),
      widgetLineas('Errores 5xx (proporción)', 'sum(rate(ipam_http_requests_total{codigo=~"5.."}[5m])) / sum(rate(ipam_http_requests_total[5m]))', { x: 0, y: 12 }),
      widgetLineas('Rechazos de autenticación y límites', 'sum by (motivo) (rate(ipam_auth_rechazos_total[5m]))', { x: 6, y: 12 }),
      widgetLineas('Base de datos arriba (1 = sí)', 'min(ipam_db_up)', { x: 0, y: 16, ancho: 4 }),
      widgetLineas('Segundos desde el último barrido', 'time() - ipam_barredor_ultima_ejecucion_timestamp', { x: 4, y: 16, ancho: 4, unidad: 's' }),
      widgetLineas('Tokens activos y por vencer', '{__name__=~"ipam_tokens_activos|ipam_tokens_por_vencer"}', { x: 8, y: 16, ancho: 4 }),
    ] },
  };
}

function salidas() {
  const o = {};
  for (const a of ALERTAS) o[`docs/ops/alertas/cloud-monitoring/${slug(a.id)}.json`] = `${JSON.stringify(politica(a), null, 2)}\n`;
  o['docs/ops/alertas/cloud-monitoring/alertas.tf'] = tf();
  o['docs/ops/alertas/cloud-monitoring/variables.tf'] = TF_VARIABLES;
  o['docs/ops/alertas/cloud-monitoring/versions.tf'] = TF_VERSIONS;
  o['docs/ops/alertas/prometheusrule.yaml'] = prometheusRule();
  o['docs/ops/alertas/reglas-prometheus.yml'] = reglasPlanas();
  o['docs/ops/gcp/dashboard-ipam.json'] = `${JSON.stringify(dashboard(), null, 2)}\n`;
  return o;
}

if (require.main === module) {
  const o = salidas();
  if (process.argv.includes('--texto')) { process.stdout.write(JSON.stringify(o)); process.exit(0); }
  for (const [ruta, contenido] of Object.entries(o)) {
    const destino = path.join(RAIZ, ruta);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  }
  console.log(`Generados ${Object.keys(o).length} archivos de alertas y dashboard.`);
}
module.exports = { ALERTAS, salidas, slug };
