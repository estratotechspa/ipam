# Portabilidad: qué servicio hace cada papel en cada lugar

El IPAM es una imagen Docker + variables de entorno. Esta tabla responde: «si me cambio de lugar, ¿qué uso en vez de lo que usaba?».
Nada de esto está escrito en el código: cambia solo la configuración y el manifiesto de [`despliegue/`](../despliegue/).

## Equivalencias entre nubes y plataformas

| Papel | POC (Render + Supabase) | Google Cloud | AWS | Azure | Servidor propio |
|---|---|---|---|---|---|
| **Ejecutar la imagen** | Servicio web con Docker | Cloud Run · GKE | ECS/Fargate · EKS | Container Apps · AKS | Docker / Compose / k3s |
| **Base de datos PostgreSQL** | Supabase (proyecto dedicado) | Cloud SQL para PostgreSQL | RDS / Aurora PostgreSQL | Azure Database for PostgreSQL (servidor flexible) | PostgreSQL 14–17 propio |
| **Conexión recomendada** | Pooler en **modo sesión** (puerto 5432) | Socket de Cloud SQL o IP privada | Endpoint directo (sin RDS Proxy en modo transacción) | Conexión directa (5432) | Directa |
| **Secretos** | Variables de entorno del panel | Secret Manager | Secrets Manager / Parameter Store | Key Vault | Docker secrets, Vault, archivos con permisos |
| **Cómo llegan al contenedor** | Variable de entorno | Variable o archivo montado (`NOMBRE_FILE`) | ídem | ídem | ídem |
| **Identidad de la carga de trabajo (sin llaves)** | — (no aplica) | Cuenta de servicio · Workload Identity | Rol de IAM · IRSA / Pod Identity | Identidad administrada · Workload Identity | Cuenta de sistema del servidor |
| **Balanceador / entrada** | Entrada propia de Render | Cloud Load Balancing (Ingress `gce`) | ALB (Ingress `alb`) | Application Gateway / enrutamiento de aplicaciones | nginx · HAProxy · Traefik |
| **Saltos de proxy (`TRUST_PROXY`)** | 1 (verificar) | 2 con ALB de Google (verificar) | 1 con ALB (verificar) | 1 (verificar) | los que tengas |
| **Registro de imágenes** | GHCR / GitLab Registry | Artifact Registry | ECR | ACR | Registry propio (Harbor…) |
| **Métricas (`/metrics`)** | Sin recolector (el servicio duerme) | Managed Service for Prometheus + Cloud Monitoring | Managed Prometheus / CloudWatch | Azure Monitor (Prometheus administrado) | Prometheus propio |
| **Trazas (OTLP)** | — | Cloud Trace (vía colector OTLP) | X-Ray / Collector | Application Insights / Collector | Jaeger · Tempo |
| **Eventos (futuro)** | webhook | Pub/Sub | SNS/SQS | Event Grid / Service Bus | RabbitMQ · NATS |
| **Login corporativo** | OIDC genérico | Google Workspace (OIDC) | Cognito / cualquier OIDC | Microsoft Entra ID | Keycloak |

> Los nombres de servicio son orientativos y los productos cambian: valida en la documentación de cada proveedor antes de decidir.
> **Los límites y precios de los planes gratuitos cambian**: este repositorio no cita cifras. Verifícalas en la página oficial de cada servicio.

## Qué cambia en cada escenario

| Escenario | Qué cambia | Qué NO cambia |
|---|---|---|
| **Local → POC** | `DATABASE_URL` (pooler de sesión), `DATABASE_SCHEMA=ipam`, auth Basic con hash, `TRUST_PROXY=1` | Imagen, código, esquema SQL |
| **POC → Cloud Run / GKE** | `DATABASE_URL` (Cloud SQL), secretos desde Secret Manager, `PUBLIC_URL`, OIDC de Google | Imagen, código, esquema SQL, API |
| **GCP → AWS o Azure** | Overlay de Helm (`values-eks.yaml` / `values-aks.yaml`), base gestionada, identidad de carga de trabajo | Imagen, código, esquema SQL, API |
| **Nube → plataforma central futura («Safiro»/«DS»)** | Quien opere la plataforma define dónde corre la imagen; se mantienen las variables | Todo lo demás: el contrato es la API OpenAPI |

## Reglas duras que hacen posible esto
1. **PostgreSQL estándar 14–17.** Única extensión: `btree_gist` (contrib). Nada propio de un proveedor.
2. **Pooler en modo sesión o conexión directa.** El modo transacción rompe los *advisory locks* (candados que evitan reservas duplicadas). Es una particularidad de cómo funcionan esos pooler, no del IPAM.
3. **Identidad OIDC genérica.** Cualquier emisor con las variables `OIDC_*`.
4. **El código no importa SDK de proveedor.** Lo vigila `scripts/verificar-portabilidad.sh` en CI y pre-commit.
5. **El IPAM es dueño de sus tablas.** Los demás agentes solo usan la API.

Decisión completa y alternativas: [ADR 0008](adr/0008-portabilidad-entre-nubes.md).
