#!/usr/bin/env sh
# Escanea con gitleaks SOLO lo que está en el área de preparación (staged). Usa el contenedor fijado en scripts/ci/escanear.sh.
# Sin Docker avisa y deja pasar (el CI vuelve a escanear todo el repositorio y es la barrera que cuenta).
set -eu
RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "· secretos: sin Docker, se omite en el hook (el CI lo comprueba)." >&2; exit 0
fi
GITLEAKS=$(grep -E "^GITLEAKS=" "$RAIZ/scripts/ci/escanear.sh" | head -1 | sed "s/^GITLEAKS='\\([^']*\\)'.*/\\1/")
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# Se copian los archivos preparados tal como van a quedar en el commit y se escanean sin historial.
git diff --cached --name-only --diff-filter=ACMR -z | while IFS= read -r -d '' f; do mkdir -p "$tmp/$(dirname "$f")"; git show ":$f" > "$tmp/$f" 2>/dev/null || true; done
cp "$RAIZ/.gitleaks.toml" "$tmp/.gitleaks.toml"
docker run --rm -v "$tmp:/repo:ro" "$GITLEAKS" detect --source /repo --no-git --config /repo/.gitleaks.toml --redact --no-banner
