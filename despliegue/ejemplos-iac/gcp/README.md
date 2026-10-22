# Ejemplo OpenTofu · IPAM en Google Cloud

> **NO VALIDADO CONTRA UNA CUENTA REAL.** Se comprobó la sintaxis con `tofu validate` y se escanea con Checkov/Trivy en CI;
> nadie ha ejecutado `tofu apply` con este código. Léelo, adáptalo y pruébalo primero en un proyecto desechable.

Crea: Cloud SQL (PostgreSQL 16, **sin IP pública**: acceso por IP privada con peering de servicios; Cloud Run sale a la VPC con egreso directo) · Cloud Run (servicio + job de migración) · Secret Manager · dos cuentas de servicio de **permisos mínimos**
(`runtime`: solo Cloud SQL Client y sus propios secretos; `migrador`: solo Cloud SQL Client y el secreto de migración).

```bash
cd despliegue/ejemplos-iac/gcp
cp terraform.tfvars.example terraform.tfvars    # edita con tus datos
tofu init && tofu plan -out plan.bin            # `terraform` funciona igual
tofu apply plan.bin
gcloud run jobs execute ipam-dev-migrar --region us-central1 --wait    # aplica el esquema
```

- **El estado de OpenTofu contiene claves** (las contraseñas de los usuarios de la base, el token de métricas). Usa un backend remoto cifrado y restringido.
- Después de crear la base, entra con un usuario administrador y ejecuta los `GRANT` de `ipam_app` (ver `docs/ACCESO-Y-SEGURIDAD.md`).
- La base y las redes críticas llevan `lifecycle { prevent_destroy = true }`: para destruir hay que quitar esa línea a propósito.
- Los rangos de red y nombres son de relleno (FICTICIOS).
