#!/usr/bin/env bash
# Sincroniza la carpeta bridge/ del repo de Comandero con este repo del Bridge.
# Uso:  ./sync.sh ~/Desktop/comanderoapp   [mensaje de commit]
set -euo pipefail

SRC="${1:-$HOME/Desktop/comanderoapp}"
MSG="${2:-sync desde comandero}"
DEST="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$SRC/bridge" ]; then
  echo "No encuentro $SRC/bridge — pasa la ruta del repo de Comandero como primer argumento."
  exit 1
fi

echo "==> Actualizando repo de Comandero en $SRC"
cd "$SRC"
git checkout -- public/version.json 2>/dev/null || true
git pull --ff-only

echo "==> Copiando bridge/ -> $DEST"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'ios' \
  --exclude 'android' \
  --exclude 'release' \
  --exclude 'build' \
  --exclude 'sync.sh' \
  "$SRC/bridge/" "$DEST/"

cd "$DEST"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$MSG"
  git push
  echo "==> Cambios subidos."
else
  echo "==> Sin cambios."
fi
