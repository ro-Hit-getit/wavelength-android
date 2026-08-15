@echo off
setlocal
cd /d "%~dp0"
echo === Wavelength Android APK build ===
where node >nul 2>nul || (echo Node.js is required.& pause& exit /b 1)
where npm >nul 2>nul || (echo npm is required.& pause& exit /b 1)
if not exist "%ANDROID_HOME%" if not exist "%LOCALAPPDATA%\Android\Sdk" (
  echo Android SDK not found. Install Android Studio and the Android SDK first.
  pause
  exit /b 1
)
echo Installing JavaScript dependencies...
npm install || goto :fail
echo Preparing web app...
npm run build:web || goto :fail
if not exist android (
  echo Generating Android platform...
  npx cap add android || goto :fail
)
echo Syncing native project...
npx cap sync android || goto :fail
echo Building debug APK...
cd android
gradlew.bat assembleDebug || goto :fail
cd ..
echo.
echo APK created:
echo %CD%\android\app\build\outputs\apk\debug\app-debug.apk
pause
exit /b 0
:fail
echo.
echo Build failed. Open the terminal output above to see the error.
pause
exit /b 1
