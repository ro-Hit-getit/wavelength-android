# Build the Wavelength APK automatically

This project now includes `.github/workflows/build-android-apk.yml`. Push the project to a GitHub repository, open **Actions → Build Wavelength Android APK**, and run it (or push to `main`). GitHub Actions will install Node/Java/Android tooling, install Capacitor dependencies, generate the Android project, sync it, build the debug APK, and upload `app-debug.apk` as an artifact.

The workflow uses Capacitor 8 and the native Media Session plugin for Android notification/lock-screen controls. The plugin exposes metadata, playback state, action handlers and position state to the native device controls.

For local Windows builds, install Android Studio + SDK and JDK 21, then run:

```powershell
npm install
npm run build:web
npx cap add android
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

APK: `android\app\build\outputs\apk\debug\app-debug.apk`
