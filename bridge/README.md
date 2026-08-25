# Comandero Bridge

Agente local de impresión de Comandero. Recibe los tickets desde la app web
(a través de la nube) y los imprime en la impresora térmica de red (ESC/POS,
TCP 9100) sin cuadros de diálogo.

Este repositorio es **independiente** de la app web Comandero: contiene sólo
el puente y sus instaladores.

```
bridge/
├── desktop/   Electron → .app (macOS), .exe (Windows), Linux x64
└── mobile/    Capacitor → .ipa (iPad/iPhone) y .apk (Android)
```

Ambas versiones hablan exactamente el mismo protocolo con la nube
(`agent_heartbeat`, `agent_pending_jobs`, `agent_claim_job`, `agent_get_printer`,
`agent_finish_job`) y generan el mismo ESC/POS (CP858, corte parcial), así que
un iPad o una tablet Android pueden ser el **dispositivo principal** sin
depender de ningún ordenador.

## Vinculación (igual en todas las plataformas)

1. App web: **Admin → Impresoras → Agentes locales → Vincular nuevo agente**.
2. Abre Comandero Bridge en el dispositivo, escribe el código de 6 dígitos y pulsa **Vincular**.
3. En la app web, edita cada impresora y asígnale ese agente (IP + puerto 9100).

---

## Escritorio (macOS / Windows / Linux)

```bash
cd desktop
npm install
npm start                 # desarrollo
npm run package:mac       # .app universal
npm run package:win       # .exe x64
npm run package:linux     # Linux x64
```

Los binarios quedan en `desktop/release/`.

---

## Móvil (iPad y Android)

Requisitos: Node 18+, y para iOS un Mac con Xcode 15+ y cuenta de Apple Developer.

```bash
cd mobile
npm install
npx cap add android      # sólo la primera vez
npx cap add ios          # sólo la primera vez (en Mac)
npx cap sync
```

### Android (.apk)

```bash
npx cap sync android
cd android && ./gradlew assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

Para depurar rápido: `./gradlew assembleDebug` (APK instalable directamente).

### iPad / iPhone (.ipa)

```bash
npx cap sync ios
npx cap open ios
```

En Xcode:

1. Target **App → Signing & Capabilities**: activa *Automatically manage signing*
   y elige tu **Team**. Bundle ID: `online.comandero.bridge`.
2. Selecciona **Any iOS Device (arm64)** y **Product → Archive**.
3. En el Organizer: **Distribute App**
   - **Ad Hoc** o **Development** → genera el `.ipa` para instalar en tus iPads
     (Apple Configurator, Sideloadly o AltStore).
   - **App Store Connect** → TestFlight / App Store.

#### Permisos iOS ya configurados

`ios/App/App/Info.plist` debe incluir (Capacitor no los añade solo):

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Comandero Bridge necesita la red local para enviar los tickets a la impresora.</string>
<key>NSBonjourServices</key>
<array><string>_pdl-datastream._tcp</string><string>_printer._tcp</string><string>_ipp._tcp</string></array>
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

> Sin `NSLocalNetworkUsageDescription` iOS bloquea la conexión TCP a la impresora.

---

## Notas

- La configuración del emparejamiento se guarda localmente (fichero de config en
  escritorio, `localStorage` en móvil). Desvincular la borra.
- Las impresoras se definen siempre en la app web (IP y puerto), no en el Bridge.
- iOS suspende las apps en segundo plano: mantén el Bridge en primer plano en el
  iPad principal (recomendado: iPad conectado a corriente y bloqueo automático desactivado).
