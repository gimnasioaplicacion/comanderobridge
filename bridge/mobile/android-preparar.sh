#!/usr/bin/env bash
# Prepara el proyecto Android del Bridge:
# - permisos de red / red local (impresión por TCP 9100)
# - tráfico en claro permitido hacia la LAN (impresoras no usan TLS)
# Ejecutar después de `npx cap sync android`.
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$BASE_DIR/android"
MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"

[ -f "$MANIFEST" ] || { echo "No existe $MANIFEST. Ejecuta antes: npx cap add android"; exit 1; }

add_perm() {
  local perm="$1"
  if ! grep -q "android.permission.$perm" "$MANIFEST"; then
    perl -pi -e "s#(<manifest[^>]*>)#\$1\n    <uses-permission android:name=\"android.permission.$perm\" />#" "$MANIFEST"
    echo "Permiso añadido: $perm"
  fi
}

add_perm INTERNET
add_perm ACCESS_NETWORK_STATE
add_perm ACCESS_WIFI_STATE
add_perm WAKE_LOCK

# Permitir HTTP/TCP en claro (impresoras de red)
if ! grep -q 'android:usesCleartextTraffic="true"' "$MANIFEST"; then
  perl -pi -e 's#(<application\b)#$1 android:usesCleartextTraffic="true"#' "$MANIFEST"
  echo "usesCleartextTraffic activado"
fi

echo "AndroidManifest.xml actualizado."
