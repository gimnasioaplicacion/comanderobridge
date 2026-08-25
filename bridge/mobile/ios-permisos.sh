#!/usr/bin/env bash
# Inyecta en ios/App/App/Info.plist los permisos que necesita el Bridge
# (red local + impresión por Bonjour + declaración de cifrado para App Store).
# Ejecutar después de `npx cap add ios` y antes de `npx cap sync ios`.
set -euo pipefail

PLIST="$(cd "$(dirname "$0")" && pwd)/ios/App/App/Info.plist"
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

echo "Info.plist actualizado."
