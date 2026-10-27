output "servicio_url" {
  description = "URL interna del servicio de Cloud Run (la entrada pública la da tu balanceador)."
  value       = google_cloud_run_v2_service.ipam.uri
}

output "cuenta_runtime" {
  description = "Cuenta de servicio con la que corre la app (solo datos)."
  value       = google_service_account.runtime.email
}

output "migrar_job" {
  description = "Job que aplica el esquema. Ejecútalo antes del primer despliegue y tras cada actualización."
  value       = google_cloud_run_v2_job.migrar.name
}

output "conexion_cloud_sql" {
  description = "Nombre de conexión de la instancia (para el Cloud SQL Auth Proxy)."
  value       = google_sql_database_instance.ipam.connection_name
}
