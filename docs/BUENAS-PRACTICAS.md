# Buenas prácticas

Para quien opera el IPAM y para quien diseña pipelines que lo usan.

## 1 · *Human-in-the-loop* (obligatorio)
Ningún cambio automático debe volverse definitivo sin la aprobación de una persona.
- **El agente solo reserva.** Confirma únicamente después de una aprobación humana real, y solo con `aprobado_por` y `referencia` verdaderos.
- **El paso de aprobación va en un ambiente protegido** del pipeline (GitLab *protected environments* / GitHub *environments* con revisores). Es la única garantía real: el IPAM guarda quién dice haber aprobado pero **no puede comprobarlo** ([LIMITACIONES](LIMITACIONES.md)).
- **Quien aprueba no es quien escribió el cambio** (separación de funciones).
- Si el apply falla o se rechaza: **liberar**. Si nadie decide: la reserva **expira sola** (24 h; ajustable hasta 72 h).
- Revisa el plan antes de aprobar, no solo el rango reservado. Diseño completo en [ARQUITECTURA](ARQUITECTURA.md#4--reservas-tentativas-y-human-in-the-loop).

## 2 · Pipelines
- Usa `Idempotency-Key` estable por cambio (por ejemplo, id del MR + pool): un reintento no duplica reservas.
- Un token por pipeline, con rol `agente`, cuota baja y vencimiento corto; guárdalo como variable **enmascarada y protegida**.
- Orden de ejecución: infraestructura crea el proyecto → redes aplica políticas, VPC, subredes y firewall → infraestructura despliega el resto ([diagrama](ARQUITECTURA.md#5--orden-de-ejecución-entre-equipos-mvp-del-cliente)).
- Etapas: `validate → scan (Trivy y Checkov) → plan → aprobación manual → apply → confirmar-ipam`, con `liberar-ipam` si falla o se rechaza ([ejemplo](ops/gitlab/README.md)).
- Las redes críticas llevan `lifecycle { prevent_destroy = true }`.
- Usa `tofu` (OpenTofu); `terraform` es compatible.
- Sin llaves de nube de larga duración: federación OIDC ([MIGRAR-A-GITLAB](ops/MIGRAR-A-GITLAB.md)).

## 3 · Gestión de rangos
- Define los pools por ambiente y tipo antes de asignar; no mezcles ambientes en un pool.
- Deja espacio libre: alerta cuando un pool pase de 80 %.
- Libera un segmento solo cuando la red realmente se eliminó.
- Los rangos de ejemplo y pruebas son ficticios; en producción no copies los de la documentación.

## 4 · Operación
- Migrar es un paso aparte (`npm run migrar`) con el rol migrador; la app corre con `ipam_app`.
- Respalda la base (nativo del proveedor) y prueba la restauración ([RESPALDO-Y-RECUPERACION](ops/RESPALDO-Y-RECUPERACION.md)).
- Activa las alertas y el dashboard ([OBSERVABILIDAD](ops/OBSERVABILIDAD.md)).
- Revisa la auditoría de forma periódica, sobre todo confirmaciones y tokens.
- Rota secretos y tokens con vencimiento; nada de secretos en el repo o en chats.

## 5 · Desarrollo
- Una guardia (`make portabilidad`) impide acoplar el núcleo a un proveedor: respétala.
- Antes de subir: `make lint test` (formato, lint, tipos y pruebas contra PostgreSQL real). Ver [CONTRIBUIR](CONTRIBUIR.md) y [CALIDAD-Y-SEGURIDAD-DEL-CODIGO](CALIDAD-Y-SEGURIDAD-DEL-CODIGO.md).
- Commits en español con formato Conventional Commits; cambios por rama y revisión.
