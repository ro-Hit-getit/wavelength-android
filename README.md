# Wavelength — personal music app

This package contains the current Wavelength web app plus an Android/Capacitor packaging layer.

## Features already in the web app

- YouTube library synced with Supabase
- YouTube title/artist detected from the link
- Separate YouTube and Local Music libraries
- Local audio stored in IndexedDB on the device
- Local music scanner/folder picker
- Local favorites and recently played
- Sorting for YouTube and Local libraries
- Queue, shuffle, repeat, previous/next
- Dedicated Now Playing waveform screen
- Mobile bottom navigation and responsive layout
- Browser Media Session metadata and controls where supported
- PWA manifest + service-worker shell

## Android

Capacitor is the native wrapper. Run the commands in `BUILD-ANDROID.md` on a machine with Android Studio/SDK installed.

## Native Android media controls

The Android build uses `@capgo/capacitor-media-session` v8 for native media-session metadata, play/pause, previous/next and seek controls. The web Media Session API remains as the browser fallback.

A GitHub Actions workflow is included to build the APK automatically. See `BUILD-APK-GITHUB.md`.
