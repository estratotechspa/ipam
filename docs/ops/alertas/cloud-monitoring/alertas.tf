# Alertas del IPAM para Cloud Monitoring (OpenTofu / Terraform). GENERADO por scripts/ci/generar-alertas.js: no lo edites a mano.
# Necesitan que las métricas de /metrics lleguen a Cloud Monitoring (Google Managed Prometheus con el PodMonitoring de values-gke.yaml, o un recolector propio).
# NO validado contra una cuenta real: se comprobó la sintaxis con `tofu validate`.
locals {
  alertas = {
    ipam_pool_sobre_80 = {
      nombre    = "IPAM · pool sobre 80 % de utilización"
      query     = "ipam_pool_utilizacion_ratio > 0.8"
      duracion  = "600s"
      severidad = "warning"
      alerta    = "IpamPoolSobre80"
      doc       = "Un pool se está llenando. Revisa `docs/ops/RUNBOOK.md` → «Un pool está lleno»: libera rangos que ya no se usen, revisa reservas colgadas o planifica un pool nuevo."
    }
    ipam_pool_sobre_90 = {
      nombre    = "IPAM · pool sobre 90 % de utilización"
      query     = "ipam_pool_utilizacion_ratio > 0.9"
      duracion  = "300s"
      severidad = "critical"
      alerta    = "IpamPoolSobre90"
      doc       = "Casi sin espacio. Las nuevas reservas de ese pool empezarán a fallar con 409 `sin_espacio`. Ver `docs/ops/RUNBOOK.md` → «Un pool está lleno»."
    }
    ipam_base_de_datos_caida = {
      nombre    = "IPAM · la base de datos no responde"
      query     = "ipam_db_up == 0"
      duracion  = "120s"
      severidad = "critical"
      alerta    = "IpamBaseDeDatosCaida"
      doc       = "El servicio sigue vivo pero `/readyz` da 503. Ver `docs/ops/RUNBOOK.md` → «La base de datos está caída»."
    }
    ipam_barredor_detenido = {
      nombre    = "IPAM · el barredor no corre hace más de 5 minutos"
      query     = "time() - ipam_barredor_ultima_ejecucion_timestamp > 300"
      duracion  = "60s"
      severidad = "warning"
      alerta    = "IpamBarredorDetenido"
      doc       = "Solo tiene sentido si el servicio está SIEMPRE encendido (no en planes gratuitos que duermen). La corrección no depende del barredor (la expiración es perezosa), pero las reservas vencidas no se limpian. Ver `docs/ops/RUNBOOK.md` → «El barredor no corre»."
    }
    ipam_pico_de_401 = {
      nombre    = "IPAM · pico de respuestas 401 (no autenticado)"
      query     = "sum(rate(ipam_http_requests_total{codigo=\"401\"}[5m])) > 0.5"
      duracion  = "300s"
      severidad = "warning"
      alerta    = "IpamPicoDe401"
      doc       = "Puede ser un token vencido o revocado en un agente, o un intento de fuerza bruta. Revisa la auditoría (`token_rechazado`). Ver `docs/ops/RUNBOOK.md` → «Hay muchos 401»."
    }
    ipam_pico_de_429 = {
      nombre    = "IPAM · pico de respuestas 429 (límite excedido)"
      query     = "sum(rate(ipam_http_requests_total{codigo=\"429\"}[5m])) > 0.2"
      duracion  = "300s"
      severidad = "warning"
      alerta    = "IpamPicoDe429"
      doc       = "Un agente con un bucle roto o una cuota demasiado baja. Ver `docs/ops/RUNBOOK.md` → «Hay muchos 429»."
    }
    ipam_token_por_vencer = {
      nombre    = "IPAM · hay tokens que vencen en menos de 7 días"
      query     = "ipam_tokens_por_vencer > 0"
      duracion  = "3600s"
      severidad = "warning"
      alerta    = "IpamTokenPorVencer"
      doc       = "Rota el token: crea uno nuevo, actualiza el agente y revoca el anterior (ver `docs/ACCESO-Y-SEGURIDAD.md`)."
    }
    ipam_tasa_de_5xx = {
      nombre    = "IPAM · más de 5 % de errores 5xx"
      query     = "sum(rate(ipam_http_requests_total{codigo=~\"5..\"}[5m])) / sum(rate(ipam_http_requests_total[5m])) > 0.05 and sum(rate(ipam_http_requests_total[5m])) > 0.05"
      duracion  = "300s"
      severidad = "critical"
      alerta    = "IpamTasaDe5xx"
      doc       = "Errores internos. Busca el `request_id` de una respuesta 500 en los logs. Ver `docs/ops/RUNBOOK.md`."
    }
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
    content   = "${each.value.doc}\n\nExpresión PromQL: `${each.value.query}`."
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
