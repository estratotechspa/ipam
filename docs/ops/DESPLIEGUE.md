# Despliegue

El IPAM se entrega como **una imagen Docker y variables de entorno**. El hosting definitivo lo define Rodrigo; el POC está en Render + Supabase ([POC-RENDER-SUPABASE](POC-RENDER-SUPABASE.md)). Esta guía cubre cada escenario. Qué cambia entre nubes: [PORTABILIDAD](../PORTABILIDAD.md). Todas las variables: [CONFIGURACION](../CONFIGURACION.md).

> **Estado de verificación:** Docker Compose y el chart de Helm (`lint`/`template`, con kube-linter) están verificados; los ajustes de GKE, EKS, AKS, Cloud Run y OpenTofu **no se probaron contra cuentas reales**. Revisa cada valor antes de usarlos.

## Reglas comunes a todas las plataformas
1. **PostgreSQL 14 a 17**, conexión directa o pooler en **modo sesión** (nunca modo transacción).
2. **Dos roles de base de datos:** `ipam_migrador` (aplica el esquema) e `ipam_app` (la app). Se crean con `mvp/db/roles.sql` (PostgreSQL estándar) o `mvp/db/supabase/00-preparar.sql` (Supabase). Las contraseñas se fijan aparte.
3. **Migrar antes de arrancar:** `npm run migrar` (o el Job del chart / `job-migrar.yaml`) con `DATABASE_URL_MIGRACION`. La app comprueba la versión del esquema en `/readyz`.
4. **Sondas:** `/healthz` (vivo) y `/readyz` (listo).
5. **Detrás de un balanceador:** `TRUST_PROXY=<saltos>`; `PUBLIC_URL` con https.
6. **Secretos** solo en la plataforma (variables, `NOMBRE_FILE`, gestor de secretos).

## 1 · En tu computador (Docker Compose)
```bash
cd despliegue/docker-compose
cp .env.example .env        # edita los valores de relleno
docker compose up --wait    # base + migración + app
curl -s localhost:8080/healthz
```
Verificado: contenedor de solo lectura, usuario no root, `cap_drop: ALL`.

## 2 · Kubernetes (cualquier clúster; GKE, EKS, AKS)
```bash
# Secreto creado por ti (no queda en git):
kubectl -n ipam create secret generic ipam-secrets \
  --from-literal=DATABASE_URL='<url de ipam_app>' --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" ...
helm upgrade --install ipam mvp/chart/ipam -n ipam \
  -f despliegue/kubernetes/values-gke.yaml -f despliegue/kubernetes/values-prod.yaml \
  --set image.repository=<tu-registro>/ipam --set image.tag=<versión>
```
- **Ajuste por nube:** `values-gke.yaml`, `values-eks.yaml`, `values-aks.yaml` (ingress, identidad de carga de trabajo, `PodMonitoring` solo en GKE).
- **Ajuste por ambiente:** `values-dev.yaml`, `values-qa.yaml`, `values-prod.yaml` (réplicas, OIDC, límites, base administrada).
- El chart **se niega a renderizar** sin autenticación (arranque seguro). Con `postgres.enabled=true` incluye un PostgreSQL de prueba con respaldos opcionales ([OPERACION](../OPERACION.md)); en producción usa una base administrada.
- Un **Job** aplica el esquema en cada `install/upgrade`.

## 3 · Google Cloud
- **GKE:** sección 2 con `values-gke.yaml` (Workload Identity, Cloud SQL con IP privada, `gce` Ingress, Managed Prometheus).
- **Cloud Run + Cloud SQL:** `despliegue/cloud-run/service.yaml` y `job-migrar.yaml` (el Job migra, el servicio corre). Secretos desde Secret Manager.
- **Infraestructura como código:** `despliegue/ejemplos-iac/gcp/` (OpenTofu: Cloud Run, Cloud SQL con IP privada, Secret Manager y una cuenta de servicio de permisos mínimos).
- Alertas y dashboard para Cloud Monitoring: [ops/gcp](gcp/README.md).

## 4 · AWS, Azure y servidor propio
- **AWS (EKS):** `values-eks.yaml` + RDS PostgreSQL; secretos con Secrets Manager (driver CSI) y `asFiles: true`.
- **Azure (AKS):** `values-aks.yaml` + Azure Database for PostgreSQL; Key Vault con el driver CSI.
- **Servidor propio:** Docker Compose, o la imagen con `docker run` detrás de tu proxy inverso; PostgreSQL local con `roles.sql`.
Equivalencias servicio por servicio: [PORTABILIDAD](../PORTABILIDAD.md).

## 5 · Render + Supabase (POC)
[POC-RENDER-SUPABASE](POC-RENDER-SUPABASE.md) y `despliegue/render/render.yaml`.

## 6 · Actualizar y volver atrás
1. Construye y publica una imagen nueva (el CI lo hace al crear una etiqueta `vX.Y.Z`).
2. Migra (el esquema es **idempotente** y solo agrega).
3. Despliega la imagen (Helm `upgrade`, nueva revisión de Cloud Run, etc.).
4. Si algo sale mal: vuelve a la imagen anterior (`helm rollback` / revisión anterior). El esquema nuevo es compatible hacia atrás.
