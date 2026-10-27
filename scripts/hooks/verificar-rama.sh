#!/usr/bin/env sh
# Nombre de rama: tipo/descripcion-en-minusculas (feat/, fix/, docs/, ci/, chore/, refactor/, test/, poc/, release/, hotfix/, dependabot/, renovate/)
# o las ramas principales (main, master). Uso: verificar-rama.sh [nombre]   (sin argumento, la rama actual)
set -eu
rama="${1:-$(git rev-parse --abbrev-ref HEAD)}"
case "$rama" in
  main|master|HEAD) exit 0 ;;
esac
if printf '%s' "$rama" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|poc|release|hotfix|renovate|dependabot)/[a-z0-9][a-z0-9._/-]*$'; then exit 0; fi
echo "✗ La rama «${rama}» no sigue la convención: tipo/descripcion (p. ej. feat/ipam-agentes-completo, fix/expiracion-reservas)." >&2
exit 1
