# Publicar el Bridge en su propio repo de GitHub y compilar desde terminal

Todo lo de abajo se ejecuta **en tu Mac**. La carpeta `bridge/` vive dentro del
repo de Comandero (que ya se sincroniza con GitHub), así que el flujo es:
bajar Comandero → copiar/sincronizar `bridge/` al repo del Bridge → push → compilar.

---

## 1. Crear el repo del Bridge (una sola vez)

En GitHub crea un repo vacío, por ejemplo `comandero-bridge` (sin README).

```bash
cd ~/Desktop
git clone https://github.com/<TU-USUARIO>/comandero.git comanderoapp   # repo de la app web
git clone https://github.com/<TU-USUARIO>/comandero-bridge.git         # repo del Bridge (vacío)

# primera copia
rsync -a --delete ~/Desktop/comanderoapp/bridge/ ~/Desktop/comandero-bridge/

cd ~/Desktop/comandero-bridge
git add -A
git commit -m "Comandero Bridge: agente local (escritorio + móvil)"
git branch -M main
git push -u origin main
```

---

## 2. Sincronizar cambios (cada vez que toque el Bridge en Lovable)

```bash
cd ~/Desktop/comanderoapp
git checkout -- public/version.json     # descarta el bump automático de versión
git pull

rsync -a --delete \
  --exclude node_modules --exclude ios --exclude android --exclude release \
  ~/Desktop/comanderoapp/bridge/ ~/Desktop/comandero-bridge/

cd ~/Desktop/comandero-bridge
git add -A && git commit -m "sync desde comandero" && git push
```

Atajo: el repo del Bridge incluye `sync.sh`, así que basta con

```bash
cd ~/Desktop/comandero-bridge && ./sync.sh ~/Desktop/comanderoapp
```

---

## 3. Compilar desde terminal

### Escritorio (macOS / Windows / Linux)

```bash
cd ~/Desktop/comandero-bridge/desktop
npm install
npm run package:mac      # .app / .dmg en desktop/release/
npm run package:win      # .exe
npm run package:linux
```

### Android (.apk)

```bash
cd ~/Desktop/comandero-bridge/mobile
npm install
npx cap add android            # sólo la primera vez
npx cap sync android
cd android && ./gradlew assembleRelease
# apk: mobile/android/app/build/outputs/apk/release/app-release.apk
```

### iPad / iPhone (.ipa) — todo por terminal

```bash
cd ~/Desktop/comandero-bridge/mobile
npm install
npx cap add ios                # sólo la primera vez
./ios-permisos.sh              # inyecta permisos de red local en Info.plist
npx cap sync ios

# archive + export (sustituye TEAMID por tu Team ID de Apple Developer)
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/App.xcarchive archive \
  DEVELOPMENT_TEAM=TEAMID CODE_SIGN_STYLE=Automatic

xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/ipa
# .ipa: mobile/build/ipa/App.ipa
```

`ExportOptions.plist` ya está en `mobile/` — sólo cambia `TEAMID` por el tuyo.
Con `method = development` instalas en tus iPads (Apple Configurator, Sideloadly
o `xcrun devicectl device install app --device <UDID> build/ipa/App.ipa`).
Cambia a `app-store` para subirlo a TestFlight/App Store con:

```bash
xcrun altool --upload-app -f build/ipa/App.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

Tu Team ID lo ves con: `xcrun xcodebuild -showBuildSettings 2>/dev/null | grep DEVELOPMENT_TEAM`
o en developer.apple.com → Membership.
