# IPAM

Un **IPAM** (*IP Address Management*, gestión de direcciones IP) para entregar subredes de forma ordenada, **sin que dos redes reciban rangos que se pisan**, y con una **persona que aprueba** antes de que un cambio automático se vuelva definitivo.

El caso de uso principal: **asignar subredes a un proyecto GCP nuevo a partir de un YAML**, desde un pipeline, con aprobación humana. También sirve para llevar el inventario de rangos de GCP, de otras nubes y on-premise.

> Estado: versión `0.3.0`, en desarrollo. Hay un POC en Render + Supabase. Lo que **no** está verificado (pipelines reales, manifiestos de nube) se declara en [`docs/LIMITACIONES.md`](docs/LIMITACIONES.md).

## Los tres conceptos

| | Qué es | Ejemplo (rangos ficticios) |
|---|---|---|
| **Pool** | El bloque grande de un ambiente y tipo (Nodos, Pods o Servicios) | `dev-nodos` = `10.210.0.0/20` |
| **Reserva** | Un pedazo del pool **apartado por un tiempo**, pendiente de aprobación; expira sola (24 h, máx. 72) | `10.210.1.0/24` para `vpc-ejemplo` |
| **Asignación** | Un pedazo del pool entregado de forma **definitiva**, con ID `ASG-000123` | `10.210.1.0/24` para `vpc-ejemplo` |

Flujo normal: **pedir (reserva) → un admin aprueba → asignación**. Un agente o un ticket de Jira nunca asigna directo.

## Qué incluye
- **Garantía en la base de datos:** dos segmentos de un pool nunca se solapan (restricción de exclusión de PostgreSQL), ni con concurrencia ni con varias réplicas.
- **Interfaz web** con pools, asignaciones, reservas, integración con Jira, tokens, usuarios y auditoría; filtro por ambiente y proveedor.
- **API REST** (`/api/v1`, contrato OpenAPI 3.1) con tokens de servicio de rol `agente`.
- **Acceso:** SSO (OIDC), usuario y contraseña para POC, o cuentas locales para pruebas. Roles `lector < agente < solicitante < admin`.
- **Seguro por defecto:** en producción no arranca sin autenticación; secretos solo por variables de entorno; auditoría de solo inserción; límite de peticiones y cuota por token.
- **Observabilidad:** `/healthz`, `/readyz`, `/metrics` (Prometheus), logs JSON, trazas OpenTelemetry opcionales, alertas y dashboard.
- **Portable:** una imagen Docker más variables de entorno; sin SDK de ninguna nube. CI/CD equivalente en GitHub y GitLab.

## Empezar en cinco minutos
Requisitos: Docker.
```bash
cd despliegue/docker-compose
cp .env.example .env                                   # valores de relleno; edítalos
docker compose up --build -d                           # http://localhost:8080
docker compose --profile semilla run --rm semilla      # datos de ejemplo FICTICIOS (opcional)
curl -s localhost:8080/readyz
docker compose down -v                                 # apaga y borra la base
```
Con el compose, el acceso queda abierto como administrador (`ALLOW_ANONYMOUS=true`): **solo para tu máquina**.

## Documentación
| Quiero… | Documento |
|---|---|
| **Aprender a usar el IPAM** (paso a paso, con capturas) | [`docs/MANUAL-DE-USUARIO.md`](docs/MANUAL-DE-USUARIO.md) |
| **Consultar cada pestaña** (referencia) | [`docs/MANUAL-DE-USO.md`](docs/MANUAL-DE-USO.md) |
| Entender los términos | [`docs/GLOSARIO.md`](docs/GLOSARIO.md) |
| Entender cómo está construido | [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) y los [ADR](docs/adr/) |
| Llamar a la API o integrar un agente | [`docs/API-Y-AGENTES.md`](docs/API-Y-AGENTES.md) |
| El YAML de redes del MVP | [`docs/CONTRATO-YAML-REDES.md`](docs/CONTRATO-YAML-REDES.md) |
| Roles, tokens, cuentas y seguridad | [`docs/ACCESO-Y-SEGURIDAD.md`](docs/ACCESO-Y-SEGURIDAD.md) |
| Todas las variables de entorno | [`docs/CONFIGURACION.md`](docs/CONFIGURACION.md) |
| Desplegarlo (Docker, Kubernetes, nubes) | [`docs/ops/DESPLIEGUE.md`](docs/ops/DESPLIEGUE.md) y [`docs/PORTABILIDAD.md`](docs/PORTABILIDAD.md) |
| El POC en Render + Supabase | [`docs/ops/POC-RENDER-SUPABASE.md`](docs/ops/POC-RENDER-SUPABASE.md) |
| Operarlo y resolver fallas | [`docs/ops/RUNBOOK.md`](docs/ops/RUNBOOK.md) y [`docs/ops/OBSERVABILIDAD.md`](docs/ops/OBSERVABILIDAD.md) |
| Respaldar, recuperar o migrar | [`docs/ops/RESPALDO-Y-RECUPERACION.md`](docs/ops/RESPALDO-Y-RECUPERACION.md) y [`docs/ops/MIGRACION.md`](docs/ops/MIGRACION.md) |
| Pipelines y paso de GitHub a GitLab | [`docs/ops/gitlab/`](docs/ops/gitlab/README.md) y [`docs/ops/MIGRAR-A-GITLAB.md`](docs/ops/MIGRAR-A-GITLAB.md) |
| Buenas prácticas (*human-in-the-loop*) | [`docs/BUENAS-PRACTICAS.md`](docs/BUENAS-PRACTICAS.md) |
| Saber qué no hace, y qué se podría copiar de un IPAM comercial | [`docs/LIMITACIONES.md`](docs/LIMITACIONES.md) y [`docs/ANALISIS-IPAM-COMERCIAL.md`](docs/ANALISIS-IPAM-COMERCIAL.md) |
| Revisar la seguridad del código | [`docs/MODELO-DE-AMENAZAS.md`](docs/MODELO-DE-AMENAZAS.md) y [`docs/CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md`](docs/CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md) |
| Contribuir | [`docs/CONTRIBUIR.md`](docs/CONTRIBUIR.md) |
| Ver los cambios por versión | [`CHANGELOG.md`](CHANGELOG.md) |

## Estructura del repositorio
```
mvp/            la aplicación (Node 22 + Express 5), su esquema SQL, chart de Helm, pruebas y e2e
  src/dominio/      reglas puras (CIDR, roles, reservas, tokens)
  src/aplicacion/   casos de uso sobre puertos
  src/adaptadores/  HTTP, PostgreSQL, autenticación, límite, eventos, métricas, trazas, Jira
  db/               esquema (idempotente), roles y semillas (FICTICIAS)
  chart/ipam/       chart de Helm
despliegue/     manifiestos por plataforma: docker-compose, kubernetes (GKE/EKS/AKS), cloud-run, render, ejemplos IaC
docs/           documentación, ADR, contrato YAML de redes, alertas y ejemplos de pipelines
scripts/        lógica de CI (la usan GitHub y GitLab), guardia de portabilidad y hooks
.github/, .gitlab-ci.yml   pipelines (envoltorios finos sobre `make` y `scripts/ci`)
```

## Desarrollo
Requisitos: Node 22, Docker y `make`. Los comandos más usados:
```bash
make lint          # ESLint, Prettier y tipos
make test          # pruebas contra un PostgreSQL real
make matriz-pg     # pruebas en PostgreSQL 14, 15, 16 y 17
make test-e2e      # navegador (Playwright) y accesibilidad
make scan          # gitleaks, Semgrep, Trivy y Checkov
make ci            # todo, igual que el CI
```
`make ayuda` lista todos los objetivos. Guía completa: [`docs/CONTRIBUIR.md`](docs/CONTRIBUIR.md).

## Seguridad
Para reportar una vulnerabilidad, mira [`SECURITY.md`](SECURITY.md). Nunca pegues secretos en el repositorio, en issues ni en chats: el repositorio solo trae `.env.example` con valores de relleno.

## Datos de ejemplo
Todos los rangos de la documentación, las semillas y las pruebas son **ficticios** (`10.210.0.0/16`, `10.220.0.0/16`, `10.230.0.0/16`, `10.240.0.0/16`) y no representan ninguna red real.
