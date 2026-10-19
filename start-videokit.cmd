@echo off
setlocal
chcp 65001 >nul
title VideoKit - Development
pushd "%~dp0" || exit /b 1
where node.exe >nul 2>&1
if errorlevel 1 goto missingnode
where npm.cmd >nul 2>&1
if errorlevel 1 goto missingnode
set "ELECTRON_RUN_AS_NODE="
if not defined VITE_PORT set "VITE_PORT=5173"
if not defined FFMPEG_PATH if exist "%~dp0vendor\win32\ffmpeg.exe" set "FFMPEG_PATH=%~dp0vendor\win32\ffmpeg.exe"
if not defined FFPROBE_PATH if exist "%~dp0vendor\win32\ffprobe.exe" set "FFPROBE_PATH=%~dp0vendor\win32\ffprobe.exe"
if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "node_modules\.bin\vite.cmd" goto install
goto ready
:install
echo Installing dependencies from package-lock.json...
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 goto failed
:ready
if /i "%~1"=="--check" goto check
echo Starting VideoKit on port %VITE_PORT%...
echo Close the application to stop the development server.
call node_modules\.bin\concurrently.cmd --kill-others --success first "node node_modules/vite/bin/vite.js --host localhost" "node node_modules/wait-on/bin/wait-on --timeout 60000 http://localhost:%VITE_PORT% && node scripts/run-electron-dev.js"
if errorlevel 1 goto failed
popd
exit /b 0
:check
node -e "const fs=require('fs');for(const p of ['electron','vite','concurrently','wait-on'])require.resolve(p);if(!fs.existsSync(require('electron')))throw Error('Electron executable missing');console.log('VideoKit dependencies OK')"
if errorlevel 1 goto failed
popd
exit /b 0
:missingnode
echo Node.js and npm are required. Install Node.js LTS, then run this file again.
goto failed
:failed
echo VideoKit failed. Please keep the error above for troubleshooting.
if /i not "%~1"=="--check" pause
popd
exit /b 1