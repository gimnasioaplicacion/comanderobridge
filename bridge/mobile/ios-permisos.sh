#!/usr/bin/env bash
# Inyecta en ios/App/App/Info.plist los permisos que necesita el Bridge
# (red local + impresión por Bonjour + declaración de cifrado para App Store)
# y corrige la compatibilidad Swift de SwiftSocket/CocoaPods para Xcode actual.
# Ejecutar después de `npx cap sync ios`.
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_APP_DIR="$BASE_DIR/ios/App"
PLIST="$IOS_APP_DIR/App/Info.plist"
PODS_DIR="$IOS_APP_DIR/Pods"

[ -f "$PLIST" ] || { echo "No existe $PLIST. Ejecuta antes: npx cap add ios"; exit 1; }

set_str()  { /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true
             /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
set_bool() { /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true
             /usr/libexec/PlistBuddy -c "Add :$1 bool $2" "$PLIST"; }

set_str NSLocalNetworkUsageDescription "Comandero Bridge necesita la red local para enviar los tickets a la impresora."
set_bool ITSAppUsesNonExemptEncryption false

/usr/libexec/PlistBuddy -c "Delete :NSBonjourServices" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSBonjourServices array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSBonjourServices:0 string _pdl-datastream._tcp" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSBonjourServices:1 string _printer._tcp" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSBonjourServices:2 string _ipp._tcp" "$PLIST"

/usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST"

(cd "$IOS_APP_DIR" && pod update SwiftSocket)

# Corregir metadatos de SwiftSocket/CocoaPods que Xcode puede seguir leyendo como Swift 3.
if [ -d "$PODS_DIR" ]; then
  while IFS= read -r -d '' file; do
    perl -pi -e 's/SWIFT_VERSION\s*=\s*(["'"'"'"']?)(?:3|3\.0)\s*;/SWIFT_VERSION = 5.0;/g; s/LastSwiftMigration\s*=\s*(["'"'"'"']?)[^;"'"'"'"']+\s*;/LastSwiftMigration = 1500;/g; s/LastUpgradeCheck\s*=\s*(["'"'"'"']?)[^;"'"'"'"']+\s*;/LastUpgradeCheck = 1500;/g' "$file"
  done < <(find "$PODS_DIR" -type f \( -name '*.pbxproj' -o -name '*.xcconfig' \) -print0)
  echo "SWIFT_VERSION corregido a 5.0"
else
  echo "Advertencia: no existe $PODS_DIR; no se pudo corregir la compatibilidad Swift."
fi

echo "Info.plist y compatibilidad Swift actualizados."
