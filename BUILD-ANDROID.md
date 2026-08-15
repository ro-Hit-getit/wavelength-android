# Wavelength Android build

Wavelength is packaged as a Capacitor Android app. Capacitor is designed to drop into an existing web app and add an Android platform (`npx cap add android`).

## Requirements on your Windows laptop

- Node.js LTS
- Android Studio with Android SDK + SDK Platform + Build Tools
- JDK 21 (current Capacitor 8 toolchain)

## First build

Open this folder in VS Code/PowerShell:

```powershell
npm install
npx cap add android
npx cap sync android
npx cap open android
```

Then in Android Studio: **Build → Build APK(s)**.

The debug APK will be under:

`android/app/build/outputs/apk/debug/app-debug.apk`

## Important

The current web player already supports local IndexedDB music and browser Media Session. The Android wrapper gives it standalone app mode. For *guaranteed* Android lock-screen/notification playback for local audio, the final native build should use an Android MediaSession/Media3 audio service rather than relying only on WebView Media Session. This is deliberately kept as a separate native layer so the same web code remains usable on laptop/browser.

YouTube playback remains through the official YouTube IFrame player; the app does not extract or download YouTube audio.
