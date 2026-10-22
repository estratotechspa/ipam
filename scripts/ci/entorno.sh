# shellcheck shell=sh
# ÚNICO archivo que conoce el proveedor de CI. Traduce las variables de GitHub Actions (GITHUB_*) o de GitLab CI (CI_*) a variables NEUTRAS
# que usan todos los demás scripts, el Makefile y los pipelines:
#
#   IPAM_PROVEEDOR           github | gitlab | local
#   IPAM_SHA                 commit que se construye
#   IPAM_SHA_CORTO           primeros 8 caracteres
#   IPAM_RAMA                nombre de la rama (en un pull/merge request, la rama de origen)
#   IPAM_RAMA_POR_DEFECTO    rama por defecto del repositorio (NO se escribe a fuego: main, master, la que sea)
#   IPAM_ES_RAMA_PRINCIPAL   true si se está construyendo la rama por defecto
#   IPAM_ES_SOLICITUD        true si es un pull request (GitHub) o merge request (GitLab)
#   IPAM_ES_TAG              true si se construye una etiqueta de versión (v1.2.3)
#   IPAM_VERSION             versión: la etiqueta sin la «v», o la de package.json (con -SHA en ramas y solicitudes)
#   IPAM_REGISTRY            URL del registry (sin esquema), p. ej. ghcr.io/org  ·  registry.gitlab.com/grupo
#   IPAM_IMAGEN              nombre completo de la imagen, sin etiqueta, p. ej. ghcr.io/org/ipam
#   IPAM_REGISTRY_USUARIO / IPAM_REGISTRY_CLAVE   credenciales de publicación (si el CI las entrega)
#
# Uso: `. scripts/ci/entorno.sh` (carga las variables) o `sh scripts/ci/entorno.sh --mostrar` (las imprime, para depurar).
# Cualquier variable IPAM_* ya definida por quien llama MANDA (así se puede forzar otro registry, otra rama, etc.).

_ipam_raiz=$(cd "$(dirname "${BASH_SOURCE:-$0}")/../.." 2>/dev/null && pwd)

_dado() { eval "[ -n \"\${$1:-}\" ]"; }
_fijar() { if ! _dado "$1"; then eval "$1=\$2"; fi; export "$1"; }

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  _fijar IPAM_PROVEEDOR github
  _fijar IPAM_SHA "${GITHUB_SHA:-}"
  if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then _fijar IPAM_ES_SOLICITUD true; _fijar IPAM_RAMA "${GITHUB_HEAD_REF:-}"; else _fijar IPAM_ES_SOLICITUD false; _fijar IPAM_RAMA "${GITHUB_REF_NAME:-}"; fi
  # GitHub no entrega la rama por defecto como variable: el workflow la pasa como IPAM_RAMA_POR_DEFECTO (github.event.repository.default_branch).
  if [ "${GITHUB_REF_TYPE:-}" = tag ]; then _fijar IPAM_ES_TAG true; _fijar IPAM_TAG "${GITHUB_REF_NAME:-}"; else _fijar IPAM_ES_TAG false; fi
  _repo=$(printf '%s' "${GITHUB_REPOSITORY:-}" | tr 'A-Z' 'a-z')
  _fijar IPAM_REGISTRY "ghcr.io/$(printf '%s' "${GITHUB_REPOSITORY_OWNER:-}" | tr 'A-Z' 'a-z')"
  _fijar IPAM_IMAGEN "ghcr.io/${_repo}"
  _fijar IPAM_REGISTRY_USUARIO "${GITHUB_ACTOR:-}"
elif [ -n "${GITLAB_CI:-}" ]; then
  _fijar IPAM_PROVEEDOR gitlab
  _fijar IPAM_SHA "${CI_COMMIT_SHA:-}"
  if [ "${CI_PIPELINE_SOURCE:-}" = merge_request_event ]; then _fijar IPAM_ES_SOLICITUD true; _fijar IPAM_RAMA "${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-}"; else _fijar IPAM_ES_SOLICITUD false; _fijar IPAM_RAMA "${CI_COMMIT_BRANCH:-${CI_COMMIT_REF_NAME:-}}"; fi
  _fijar IPAM_RAMA_POR_DEFECTO "${CI_DEFAULT_BRANCH:-}"
  if [ -n "${CI_COMMIT_TAG:-}" ]; then _fijar IPAM_ES_TAG true; _fijar IPAM_TAG "${CI_COMMIT_TAG}"; else _fijar IPAM_ES_TAG false; fi
  _fijar IPAM_REGISTRY "${CI_REGISTRY:-}"
  _fijar IPAM_IMAGEN "${CI_REGISTRY_IMAGE:-}"
  _fijar IPAM_REGISTRY_USUARIO "${CI_REGISTRY_USER:-}"
  _fijar IPAM_REGISTRY_CLAVE "${CI_REGISTRY_PASSWORD:-}"
else
  _fijar IPAM_PROVEEDOR local
  _fijar IPAM_SHA "$(git -C "$_ipam_raiz" rev-parse HEAD 2>/dev/null || echo desconocida)"
  _fijar IPAM_RAMA "$(git -C "$_ipam_raiz" rev-parse --abbrev-ref HEAD 2>/dev/null || echo local)"
  _fijar IPAM_ES_SOLICITUD false
  _fijar IPAM_ES_TAG false
  _fijar IPAM_REGISTRY "localhost"
  _fijar IPAM_IMAGEN "localhost/ipam"
fi

# Rama por defecto: si el CI no la entregó, se deduce del repositorio; solo como último recurso se asume «main».
if ! _dado IPAM_RAMA_POR_DEFECTO; then
  _def=$(git -C "$_ipam_raiz" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  IPAM_RAMA_POR_DEFECTO=${_def:-main}
fi
export IPAM_RAMA_POR_DEFECTO

if [ "${IPAM_RAMA:-}" = "$IPAM_RAMA_POR_DEFECTO" ] && [ "${IPAM_ES_SOLICITUD}" != true ]; then _fijar IPAM_ES_RAMA_PRINCIPAL true; else _fijar IPAM_ES_RAMA_PRINCIPAL false; fi

IPAM_SHA_CORTO=$(printf '%s' "${IPAM_SHA:-desconocida}" | cut -c1-8)
export IPAM_SHA_CORTO

# Versión: etiqueta v1.2.3 → 1.2.3; si no, la de package.json con el SHA corto (para distinguir cada construcción).
if ! _dado IPAM_VERSION; then
  if [ "${IPAM_ES_TAG}" = true ]; then
    IPAM_VERSION=$(printf '%s' "${IPAM_TAG:-}" | sed 's/^v//')
  else
    _base=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$_ipam_raiz/mvp/package.json" | head -1)
    IPAM_VERSION="${_base:-0.0.0}-${IPAM_SHA_CORTO}"
  fi
fi
export IPAM_VERSION IPAM_IMAGEN IPAM_REGISTRY

if [ "${1:-}" = "--mostrar" ]; then
  for v in IPAM_PROVEEDOR IPAM_SHA IPAM_SHA_CORTO IPAM_RAMA IPAM_RAMA_POR_DEFECTO IPAM_ES_RAMA_PRINCIPAL IPAM_ES_SOLICITUD IPAM_ES_TAG IPAM_VERSION IPAM_REGISTRY IPAM_IMAGEN IPAM_REGISTRY_USUARIO; do
    eval "printf '%s=%s\\n' \"$v\" \"\${$v:-}\""   # nunca se imprime IPAM_REGISTRY_CLAVE
  done
fi
