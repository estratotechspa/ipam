# Migrar el IPAM de GitHub a GitLab (y mantener los dos)

El repositorio vive en GitHub y el cliente usa GitLab. **La lógica de CI está en el repositorio** (`Makefile` y `scripts/ci/`); `.github/workflows/ci.yml` y `.gitlab-ci.yml` son envoltorios finos con los mismos trabajos y el mismo orden.
Por eso migrar es mover el repo, las variables y los permisos, no reescribir pipelines.

> **Qué no se pudo verificar:** los pipelines reales de GitHub y de GitLab no se ejecutaron desde aquí. Sí se validaron: `actionlint` sobre los workflows, el esquema de GitLab con `gitlab-ci-local`, y los trabajos `validar` y `probar:pg16` se **ejecutaron localmente en contenedores GitLab** con `gitlab-ci-local`.

## Equivalencias GitHub Actions ↔ GitLab CI
| Idea | GitHub Actions | GitLab CI |
|---|---|---|
| Archivo | `.github/workflows/*.yml` | `.gitlab-ci.yml` (raíz) |
| Etapas / orden | `needs:` entre trabajos | `stages:` + `needs:` |
| Imagen del trabajo | `runs-on: ubuntu-latest` (+ acciones) | `image:` (fijada por digest) |
| PostgreSQL de prueba | `services:` con `ports` y `options` de salud | `services:` con `alias: postgres` |
| Matriz (PG 14–17) | `strategy.matrix.include` | 4 trabajos que extienden `.probar` (o `parallel: matrix`) |
| Cuándo corre | `on: pull_request / push / tags` | `workflow:rules` y `rules:` |
| Rama por defecto | `github.event.repository.default_branch` → `IPAM_RAMA_POR_DEFECTO` | `$CI_DEFAULT_BRANCH` (lo traduce `entorno.sh`) |
| Pull request / merge request | `github.event_name == 'pull_request'` | `$CI_PIPELINE_SOURCE == "merge_request_event"` |
| Etiqueta de versión | `GITHUB_REF_TYPE=tag` | `$CI_COMMIT_TAG` |
| Caché de dependencias | `actions/setup-node` con `cache: npm` | `cache:` con `key: files: [package-lock.json]` |
| Artefactos | `actions/upload-artifact` | `artifacts:` |
| Secretos | *Settings → Secrets and variables → Actions* | *Settings → CI/CD → Variables* (enmascaradas y protegidas) |
| Registry de imágenes | GHCR (`ghcr.io/<org>/<repo>`) | GitLab Container Registry (`$CI_REGISTRY_IMAGE`) |
| Credenciales del registry | `GITHUB_TOKEN` | `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` |
| Federación con la nube (sin llaves) | OIDC de GitHub (`id-token: write`) | ID tokens (`id_tokens:` con `aud`) |
| Escaneos | contenedores lanzados por `scripts/ci/escanear.sh` | cada escáner corre **como imagen del trabajo** (`IPAM_ESCANEO_LOCAL=1`) |
| Docker (construir imagen) | Docker del runner | `docker:27.5-cli` + `dind` (privilegiado para multi-arquitectura) |
| Programación | `on: schedule` | *Build → Pipeline schedules* |
| Ambientes protegidos / aprobación | *Environments* con revisores | *Protected environments* con aprobadores |
| Plantillas | `.github/pull_request_template.md` | `.gitlab/merge_request_templates/Default.md` |
| Dueños del código | `CODEOWNERS` | `CODEOWNERS` (misma sintaxis básica) |
| Actualización de dependencias | Renovate | Renovate (el mismo `renovate.json`) |

## Cómo mover el repositorio
1. **Historial y ramas (con todo el historial):**
   ```bash
   git clone --mirror git@github.com:ORG/ipam.git && cd ipam.git
   git push --mirror git@gitlab.com:GRUPO/ipam.git       # ramas y etiquetas
   ```
   O usa el importador de GitLab (*New project → Import → GitHub*), que además trae issues y PR como MR.
2. **Espejo mientras conviven los dos:** *Settings → Repository → Mirroring repositories* en GitLab (empujar o traer). Elige UN lado como fuente de verdad y no escribas en los dos.
3. **Ramas protegidas:** *Settings → Repository → Protected branches*: la rama por defecto solo por MR, con aprobaciones requeridas (y CODEOWNERS obligatorio si tu plan lo permite). Etiquetas `v*`: solo mantenedores.
4. **Secretos y variables:** vuelve a crearlos a mano (no se migran). Lista mínima: `IPAM_REGISTRY_*` (GitLab ya entrega `CI_REGISTRY_*`), y las del despliegue (`DATABASE_URL_MIGRACION`, `IPAM_URL`, `IPAM_TOKEN`…). Márcalas **enmascaradas** y **protegidas**.
5. **Plantillas y dueños:** ya están en el repo (`.gitlab/merge_request_templates/Default.md`, `CODEOWNERS`). Reemplaza `@estratotechspa` por los usuarios o grupos de GitLab.
6. **Renovate:** instala la app/bot de Renovate en GitLab con el mismo `renovate.json`.
7. **Registry:** la primera etiqueta `vX.Y.Z` publica en el Container Registry del proyecto.

## Autenticación hacia nubes sin llaves de larga duración (OIDC)
Ninguno de los dos pipelines guarda llaves de la nube: el trabajo recibe un **token OIDC de corta vida** y la nube lo cambia por credenciales temporales (federación de identidad de carga de trabajo).

**GitHub OIDC** (en el workflow: `permissions: id-token: write`):
- GCP: *Workload Identity Federation* con un proveedor `https://token.actions.githubusercontent.com` y una condición sobre `repository` y `ref`.
- AWS: proveedor de identidad OIDC de IAM + rol con política de confianza sobre `token.actions.githubusercontent.com:sub`.
- Azure: credencial federada en un registro de aplicación (`subject: repo:ORG/REPO:ref:refs/heads/…`).

**GitLab ID tokens** (en el trabajo: `id_tokens: {NOMBRE: {aud: "<audiencia>"}}`, que entrega el JWT en `$NOMBRE`):
- GCP: proveedor de Workload Identity Federation con emisor `https://gitlab.com` (o tu GitLab) y mapeo `assertion.project_path`/`assertion.ref`.
- AWS: proveedor OIDC con el emisor de GitLab y `sub` = `project_path:GRUPO/PROYECTO:ref_type:branch:ref:…`.
- Azure: credencial federada con emisor GitLab.

En ambos casos: restringe por **repositorio y rama/ambiente**, nunca por organización completa, y da a la cuenta de servicio solo los permisos que necesita.

## Checklist después de migrar
- [ ] El pipeline de la rama por defecto corre completo y en verde (validar, PG 14–17, e2e, escaneos, construir).
- [ ] Un MR de prueba corre el pipeline de MR y bloquea el merge si falla.
- [ ] La rama por defecto está protegida (solo por MR) y las etiquetas `v*` restringidas.
- [ ] Las variables secretas existen, enmascaradas y protegidas; ninguna aparece en los logs.
- [ ] `make ci` sigue pasando en un clon limpio (la lógica no depende del proveedor).
- [ ] Una etiqueta `v0.3.1-prueba` (o la siguiente) publica la imagen multi-arquitectura en el Container Registry.
- [ ] Renovate abre un MR de actualización.
- [ ] `CODEOWNERS` apunta a usuarios/grupos reales de GitLab y las plantillas de MR aparecen.
- [ ] El pipeline programado de salud (`keepalive`) está creado si usas el POC gratuito.
- [ ] Los dos workflows de GitHub quedaron desactivados (o el repo archivado) para no duplicar.
