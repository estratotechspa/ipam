#!/usr/bin/env sh
# Instala helm y kube-linter en ~/.cache/ipam-herramientas/bin con versión fija Y verificación de checksum (SHA-256).
# Sin acciones ni plantillas de ningún CI: funciona igual en GitHub, GitLab o tu computador. Uso: instalar-herramientas.sh [helm] [kube-linter]
# Después:  export PATH="$HOME/.cache/ipam-herramientas/bin:$PATH"
set -eu
DESTINO="${IPAM_HERRAMIENTAS:-$HOME/.cache/ipam-herramientas}/bin"
mkdir -p "$DESTINO"
so=$(uname -s | tr 'A-Z' 'a-z'); arq=$(uname -m)
case "$arq" in x86_64|amd64) arq=amd64 ;; aarch64|arm64) arq=arm64 ;; esac
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

helm() {
  [ -x "$DESTINO/helm" ] && return 0
  v=3.17.0
  case "$so-$arq" in
    linux-amd64) esperado=fb5d12662fde6eeff36ac4ccacbf3abed96b0ee2de07afdde4edb14e613aee24 ;;
    linux-arm64) esperado=c4d4be8e80082b7eaa411e3e231d62cf05d01cddfef59b0d01006a7901e11ee4 ;;
    darwin-arm64) esperado=5db292c69ba756ddbf139abb623b02860feef15c7f1a4ea69b77715b9165a261 ;;
    darwin-amd64) esperado=0d5fd51cf51eb4b9712d52ecd8f2a3cd865680595cca57db38ee01802bd466ea ;;
    *) echo "helm: plataforma no soportada ($so-$arq)" >&2; exit 2 ;;
  esac
  t=$(mktemp -d); curl -fsSL -o "$t/h.tgz" "https://get.helm.sh/helm-v$v-$so-$arq.tar.gz"
  [ "$(sha "$t/h.tgz")" = "$esperado" ] || { echo "helm: el checksum NO coincide: descarga rechazada" >&2; rm -rf "$t"; exit 1; }
  tar -xzf "$t/h.tgz" -C "$t" && mv "$t/$so-$arq/helm" "$DESTINO/helm"; rm -rf "$t"
  echo "helm $v instalado"
}

kube_linter() {
  [ -x "$DESTINO/kube-linter" ] && return 0
  v=v0.7.1
  case "$so-$arq" in
    linux-amd64) a=kube-linter-linux; esperado=852f89a48ff6adc62347477f780889bb9eb046dd16057da0ee4e8e5b0c1b6e3e ;;
    linux-arm64) a=kube-linter-linux_arm64; esperado=ef0c06074c417bfd5b63b435ef507cd88e065b47688c4c199cda96345974a041 ;;
    darwin-amd64) a=kube-linter-darwin; esperado=fc749cd46ceb59c35e54de709694e820cbfd8c79c6b992daa1a009545744806a ;;
    darwin-arm64) a=kube-linter-darwin_arm64; esperado=d562491614ae60481678d4b3374c7b34b9abe9a79a04d549ec68e9fe0399a4db ;;
    *) echo "kube-linter: plataforma no soportada ($so-$arq)" >&2; exit 2 ;;
  esac
  t=$(mktemp -d); curl -fsSL -o "$t/k.tgz" "https://github.com/stackrox/kube-linter/releases/download/$v/$a.tar.gz"
  [ "$(sha "$t/k.tgz")" = "$esperado" ] || { echo "kube-linter: el checksum NO coincide: descarga rechazada" >&2; rm -rf "$t"; exit 1; }
  tar -xzf "$t/k.tgz" -C "$t" kube-linter && mv "$t/kube-linter" "$DESTINO/kube-linter"; rm -rf "$t"
  echo "kube-linter $v instalado"
}

[ $# -eq 0 ] && set -- helm kube-linter
for h in "$@"; do case "$h" in helm) helm ;; kube-linter) kube_linter ;; *) echo "Herramienta desconocida: $h" >&2; exit 2 ;; esac; done
