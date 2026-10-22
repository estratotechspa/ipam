#!/usr/bin/env sh
# Escaneos de seguridad PORTABLES: el mismo comando en GitHub Actions, GitLab CI o tu computador.
# Cada herramienta corre como contenedor con la versión fijada por digest (reproducible; se actualizan con Renovate).
# Uso:  scripts/ci/escanear.sh {gitleaks|semgrep|trivy-fs|trivy-imagen <imagen>|checkov|todo}
#   gitleaks    secretos en el repositorio (historial completo si hay .git; si no, el árbol de trabajo)
#   semgrep     análisis estático (SAST) del código de la aplicación, la interfaz y los scripts
#   trivy-fs    dependencias (package-lock.json), secretos y configuración (Dockerfile, chart de Helm, manifiestos, IaC)
#   trivy-imagen  vulnerabilidades de una imagen ya construida
#   checkov     IaC de ejemplo (OpenTofu/Terraform)
# Variables: IPAM_ESCANEO_LOCAL=1 usa los binarios instalados en vez de contenedores.
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)

GITLEAKS='ghcr.io/gitleaks/gitleaks@sha256:0e99e8821643ea5b235718642b93bb32486af9c8162c8b8731f7cbdc951a7f46'   # v8.21.2
SEMGREP='semgrep/semgrep@sha256:a265d09a9ca712e6624aca09056304ce4314a695b7028d65c041dd53fd44c700'             # 1.97.0
TRIVY='aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7'                 # 0.58.1
CHECKOV='bridgecrew/checkov@sha256:ead6eb24cf9884859566ecb461bf396d0e52bd9c3b9d71a221f3f5e054308347'          # 3.2.344

titulo() { printf '\n== %s\n' "$1"; }
# Trivy descarga un paquete de políticas más nuevo que a veces trae reglas que esta versión no entiende: lo reporta como ERROR no fatal
# («Trying to fallback to embedded check»). Se oculta ese ruido SIN perder el código de salida real.
sin_ruido() { _t=$(mktemp); "$@" 2>"$_t"; _c=$?; grep -v '\[rego\]' "$_t" >&2 || true; rm -f "$_t"; return "$_c"; }
necesita_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "Hace falta Docker (o IPAM_ESCANEO_LOCAL=1 con los binarios instalados)." >&2; exit 2; }; }

gitleaks() {
  titulo "gitleaks (secretos)"
  if [ "${IPAM_ESCANEO_LOCAL:-}" = 1 ]; then
    command gitleaks detect --source "$RAIZ" --config "$RAIZ/.gitleaks.toml" --redact --no-banner
  else
    necesita_docker
    # En un «git worktree» el .git es un archivo que apunta fuera del directorio montado: se escanea el árbol de trabajo.
    if [ -d "$RAIZ/.git" ]; then modo=''; else modo='--no-git'; fi
    # shellcheck disable=SC2086
    docker run --rm -v "$RAIZ:/repo:ro" "$GITLEAKS" detect --source /repo $modo --config /repo/.gitleaks.toml --redact --no-banner
  fi
}

semgrep() {
  titulo "semgrep (SAST)"
  necesita_docker
  docker run --rm -v "$RAIZ:/src:ro" "$SEMGREP" semgrep scan --config p/javascript --config p/nodejs --config p/owasp-top-ten \
    --metrics=off --quiet --error --exclude node_modules --exclude '*.test.js' /src/mvp/src /src/mvp/public /src/scripts
}

trivy_fs() {
  titulo "trivy (dependencias, secretos y configuración)"
  necesita_docker
  sin_ruido docker run --rm -v "$RAIZ:/repo:ro" -v ipam-trivy-cache:/root/.cache "$TRIVY" fs --scanners vuln,secret,misconfig \
    --severity HIGH,CRITICAL --ignore-unfixed --skip-dirs node_modules --skip-dirs mvp/node_modules --skip-dirs .terraform \
    --ignorefile /repo/.trivyignore.yaml --exit-code 1 /repo
}

trivy_imagen() {
  [ -n "${1:-}" ] || { echo "Uso: escanear.sh trivy-imagen <imagen>" >&2; exit 2; }
  titulo "trivy (imagen $1)"
  necesita_docker
  sin_ruido docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v ipam-trivy-cache:/root/.cache "$TRIVY" image \
    --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 "$1"
}

checkov() {
  titulo "checkov (IaC de ejemplo)"
  necesita_docker
  docker run --rm -v "$RAIZ:/repo:ro" "$CHECKOV" -d /repo/despliegue/ejemplos-iac/gcp --framework terraform --compact --quiet
}

caso="${1:-todo}"
case "$caso" in
  gitleaks) gitleaks ;;
  semgrep) semgrep ;;
  trivy-fs) trivy_fs ;;
  trivy-imagen) trivy_imagen "${2:-}" ;;
  checkov) checkov ;;
  todo) gitleaks; semgrep; trivy_fs; checkov; echo; echo "Escaneos: OK" ;;
  *) echo "Uso: $0 {gitleaks|semgrep|trivy-fs|trivy-imagen <imagen>|checkov|todo}" >&2; exit 2 ;;
esac
