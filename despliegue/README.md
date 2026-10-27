# Despliegue del IPAM

El IPAM se entrega como **una imagen Docker (OCI) y variables de entorno**. El código no sabe en qué nube corre ni quién lo construyó:
cada carpeta de aquí es un manifiesto **autocontenido** para una plataforma distinta, y todas usan la misma imagen.

| Carpeta | Para qué sirve | Estado |
|---|---|---|
| [`docker-compose/`](docker-compose/) | Probar en tu computador (app + PostgreSQL + migración) | Verificado en local |
| [`render/`](render/) | POC gratuito en Render + base PostgreSQL gestionada | Sintaxis validada; **no desplegado sin tu confirmación** |
| [`kubernetes/`](kubernetes/) | Cualquier clúster con el chart de Helm (`mvp/chart/ipam`) y ajustes para GKE, EKS y AKS | Chart verificado con `helm lint/template`; **overlays no probados en clústeres reales** |
| [`cloud-run/`](cloud-run/) | Cloud Run con Cloud SQL y secretos | **No validado contra una cuenta real** |
| [`ejemplos-iac/gcp/`](ejemplos-iac/gcp/) | OpenTofu: Cloud Run + Cloud SQL + Secret Manager + cuenta de servicio de permisos mínimos | **No validado contra una cuenta real** |

Qué cambia entre plataformas y cuál es el equivalente de cada servicio en cada nube: [`docs/PORTABILIDAD.md`](../docs/PORTABILIDAD.md).
Guía de cada escenario con comandos: [`docs/ops/DESPLIEGUE.md`](../docs/ops/DESPLIEGUE.md).

## Reglas que valen en todas las plataformas
1. **Base de datos**: PostgreSQL estándar 14 a 17, con conexión directa o pooler en **modo sesión** (el modo transacción rompe los *advisory locks*).
2. **Migraciones fuera del arranque**: `node src/cli/migrar.js` (o `npm run migrar`) como paso previo o Job. Excepción documentada: `MIGRAR_AL_ARRANCAR=true`.
3. **Sondas**: `GET /healthz` (vivo, no toca la base) y `GET /readyz` (listo: base alcanzable y esquema al día).
4. **Secretos** solo en variables de entorno de la plataforma o archivos montados (`NOMBRE_FILE`). Nunca en el repositorio.
5. **Detrás de un balanceador**: `TRUST_PROXY=<saltos>`.
