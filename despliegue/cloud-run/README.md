# Cloud Run (ejemplo)

> **No validado contra una cuenta real.** Son archivos de partida para adaptar; no se pudieron ejecutar sin acceso a una cuenta de Google Cloud.

Piezas: servicio (`service.yaml`), job de migración (`job-migrar.yaml`), Cloud SQL (PostgreSQL) y secretos en Secret Manager.
Para crear todo con OpenTofu, mira [`../ejemplos-iac/gcp/`](../ejemplos-iac/gcp/).

```bash
# 1) Secretos (los valores salen de tu gestor de contraseñas; nada de esto se versiona)
printf '%s' 'postgres://ipam_app:CLAVE@/ipam?host=/cloudsql/PROYECTO:REGION:INSTANCIA' | gcloud secrets create ipam-database-url --data-file=-
printf '%s' 'postgres://ipam_migrador:CLAVE@/ipam?host=/cloudsql/PROYECTO:REGION:INSTANCIA' | gcloud secrets create ipam-database-url-migracion --data-file=-
# 2) Migración y despliegue
gcloud run jobs replace job-migrar.yaml --region REGION && gcloud run jobs execute ipam-migrar --region REGION --wait
gcloud run services replace service.yaml --region REGION
```

Cosas a saber: la conexión a Cloud SQL va por socket (`?host=/cloudsql/…`), no necesita TLS adicional.
Con el escalado a cero el barredor no corre, pero **las reservas vencidas igual dejan de contar** (expiración perezosa).
`/metrics` solo se puede recolectar mientras haya una instancia viva.
