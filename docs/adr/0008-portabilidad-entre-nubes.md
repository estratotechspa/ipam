# ADR 0008 · Portabilidad entre nubes

- **Estado:** aceptada · **Fecha:** 2026-10-21 · **Relacionada con:** [0000](0000-arquitectura-desacoplada.md), [0007](0007-poc-render-supabase.md)

## Contexto
El lugar definitivo donde correrá el IPAM **no está decidido** (hoy los agentes corren locales; a futuro habrá una plataforma central, y el
cliente tiene su propia infraestructura). El POC va en Render + Supabase; el cliente usa Google Cloud y podría pedir AWS o Azure. Si el código
supiera dónde corre, cada cambio de lugar sería una reescritura.

## Decisión
**El código no conoce a ningún proveedor.** Se entrega como imagen OCI + variables de entorno, y lo específico de cada nube vive en `despliegue/` y `docs/ops/<nube>/`.

| Tema | Regla |
|---|---|
| **Base de datos** | Solo PostgreSQL estándar, versiones 14, 15, 16 y 17. Prohibido usar funciones, extensiones o esquemas propios de un proveedor. Única extensión: `btree_gist` (contrib, disponible en los servicios gestionados principales). |
| **Pooler** | Conexión directa o pooler en **modo sesión**. El modo transacción (PgBouncer, Supavisor…) **no es compatible**: los *advisory locks* que serializan las reservas se perderían entre transacciones. |
| **Esquema** | `DATABASE_SCHEMA` (por defecto `public`; el POC usa `ipam`) y roles separados: `ipam_migrador` (DDL) e `ipam_app` (solo datos). |
| **Identidad** | OIDC genérico: cualquier emisor (Google Workspace, Entra, Okta, Keycloak) con solo variables. |
| **Eventos** | Puerto `PublicadorEventos` con adaptadores `log` y `webhook` firmado (con protección SSRF). Pub/Sub, SNS/SQS o Event Grid se conectan como adaptador nuevo (ver «Cómo agregar un adaptador» en `CONTRIBUIR.md`); no están implementados. |
| **Observabilidad** | Prometheus (`/metrics`) y OpenTelemetry (OTLP) hacia cualquier backend. Dashboards y alertas de una nube concreta viven en `docs/ops/<nube>/`, nunca en el código. |
| **Imagen** | OCI multi-arquitectura (amd64 y arm64), sin registry fijo: el destino se configura por variable (GHCR, GitLab Registry, Artifact Registry, ECR, ACR…). |
| **Secretos** | Variables de entorno o archivos (`NOMBRE_FILE`): sirven igual los secretos de Kubernetes, Secret Manager, AWS Secrets Manager, Key Vault o Docker secrets. |
| **Manifiestos** | Uno por plataforma en `despliegue/`, cada uno autocontenido. |

**Guardia automática:** `scripts/verificar-portabilidad.sh` falla si en `mvp/src/` aparece `googleapis`, `@google-cloud`, `aws-sdk`, `@azure`,
`supabase` u `onrender`, o si `dominio/` y `aplicacion/` importan infraestructura. Corre en CI y en el pre-commit.

## Consecuencias
- (+) Mover el IPAM entre Render, Cloud Run, Kubernetes o un servidor propio es cambiar configuración y manifiesto, no código.
- (+) La tabla de equivalencias entre nubes (en [`PORTABILIDAD.md`](../PORTABILIDAD.md)) dice qué servicio hace cada papel en cada lugar.
- (−) No se aprovechan funciones especiales de un proveedor (p. ej. publicar directo a una cola gestionada). Si hace falta, se agrega un adaptador, no una dependencia en el núcleo.
- (−) El modo transacción del pooler, muy común en servicios gratuitos, queda prohibido: hay que usar el puerto de sesión (documentado en el POC).

## Qué NO se pudo verificar
Los manifiestos para GKE, EKS, AKS, Cloud Run y el ejemplo de OpenTofu **no se probaron contra cuentas reales** (no hay acceso). Sí se probó: el chart
con `helm lint/template`, la imagen en Docker, y el servicio contra PostgreSQL 14 a 17.
