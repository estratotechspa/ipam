# ADR 0009 · CI portable entre GitHub y GitLab, con la lógica en el repositorio

- **Estado:** aceptada · **Fecha:** 2026-10-21

## Contexto
Hoy el repo vive en GitHub y el cliente usa GitLab. Un pipeline escrito con acciones y plantillas de un proveedor obliga a reescribirlo al migrar y puede comportarse distinto.

## Decisión
- **La lógica vive en el repo:** `Makefile` (`lint`, `test`, `test-e2e`, `scan`, `build`, `helm-check`, `portabilidad`, `sbom`, `ci`) y `scripts/ci/`. Quien sea (tú en tu computador, GitHub o GitLab) corre `make ci`.
- **Los pipelines son envoltorios finos** con los mismos trabajos y el mismo orden: `.github/workflows/ci.yml` y `.gitlab-ci.yml` (validar, probar, escanear, construir, liberar).
- **Un único archivo conoce al proveedor:** `scripts/ci/entorno.sh` traduce `GITHUB_*` o `CI_*` a variables neutras (`IPAM_RAMA_POR_DEFECTO`, `IPAM_SHA`, `IPAM_REGISTRY`, `IPAM_IMAGEN`, `IPAM_VERSION`…). Una prueba falla si otro script usa variables de un proveedor.
- **La rama por defecto no se escribe a fuego** (`main` o `master`): sale de la variable neutra.
- **Herramientas sin acciones de proveedor:** helm y kube-linter se instalan con versión y checksum fijos; los escáneres (gitleaks, Semgrep, Trivy, Checkov) corren como contenedores fijados por digest, o dentro de su propia imagen en GitLab.
- **Cadena de suministro:** acciones de GitHub fijadas por commit, imágenes de CI y del producto fijadas por digest, sin `latest`; `scripts/ci/verificar-pines.js` comprueba que existen. Renovate (funciona en ambos) las actualiza; no Dependabot.
- **Sin llaves de larga duración:** federación OIDC (GitHub OIDC y GitLab ID tokens), documentada en `docs/ops/MIGRAR-A-GITLAB.md`.
- **Opcionales apagados:** firma de imagen (cosign sin llaves, `FIRMAR_IMAGEN=true`), atestación de procedencia y DAST con ZAP (`ACTIVAR_DAST=true`).

## Consecuencias
- (+) Migrar o mantener los dos proveedores es mover variables y permisos. El comportamiento es el mismo porque ambos llaman a los mismos comandos.
- (−) Dos archivos de pipeline que mantener en paralelo (una prueba comprueba que sigan llamando a lo mismo).
- (−) Donde no hay Docker (GitLab sin dind) algunos pasos (promtool, `tofu validate`, multi-arquitectura) necesitan runners con ese permiso; está documentado.
