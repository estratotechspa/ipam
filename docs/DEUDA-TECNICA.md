# Deuda técnica registrada

Decisiones tomadas a propósito para la prueba de concepto (POC). Cada punto dice qué falta y qué haría falta para cerrarlo.

## 1. Firma de imágenes (Cosign)
- **Hoy:** la imagen se publica en GHCR con SBOM y atestación de procedencia (`publicar.yml`), pero **sin firma**.
- **Falta:** firmar con Cosign (sin llaves, con la identidad OIDC de GitHub, o con la llave del cliente) y, en el clúster, exigir la firma con una política de admisión (Kyverno / Sigstore policy-controller).
- **Se decide con el cliente:** quién custodia la identidad o llave de firma.

## 2. Cifrado de extremo a extremo
- **Hoy:** TLS solo hasta el ingress (usuario → ingress). Dentro del clúster el tráfico va en HTTP (ingress → app) y la conexión app → PostgreSQL no exige TLS.
- **Falta:**
  1. App escuchando en HTTPS (certificado montado desde un Secret / cert-manager) o malla de servicios con mTLS (Istio, Linkerd).
  2. `sslmode=verify-full` en `DATABASE_URL` y TLS en la base. Con una base administrada (Cloud SQL, RDS) el servidor ya lo ofrece; con el PostgreSQL incluido en el chart hay que montar certificado y clave.
  3. HSTS (`HSTS=true`) una vez que el acceso sea solo por HTTPS.
- **Mitigación actual:** `NetworkPolicy` (solo el ingress entra a la app; solo la app y el Job de esquema llegan a la base) y base de datos sin exposición fuera del clúster.
