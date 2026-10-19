@echo off
setlocal
chcp 65001 >nul
title VideoKit v4.4.42 - 启动测试
pushd "%~dp0" || exit /b 1

echo ========================================================
echo   VideoKit v4.4.42 测试启动器 (已统一预设与工程目录)
echo ========================================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js LTS 版本。
    pause
    popd
    exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
if not defined VITE_PORT set "VITE_PORT=5173"
if not defined FFMPEG_PATH if exist "%~dp0vendor\win32\ffmpeg\ffmpeg.exe" set "FFMPEG_PATH=%~dp0vendor\win32\ffmpeg\ffmpeg.exe"
if not defined FFPROBE_PATH if exist "%~dp0vendor\win32\ffmpeg\ffprobe.exe" set "FFPROBE_PATH=%~dp0vendor\win32\ffmpeg\ffprobe.exe"
if not defined FFMPEG_PATH if exist "%LOCALAPPDATA%\Programs\videokit\resources\vendor\ffmpeg\bin\ffmpeg.exe" set "FFMPEG_PATH=%LOCALAPPDATA%\Programs\videokit\resources\vendor\ffmpeg\bin\ffmpeg.exe"
if not defined FFPROBE_PATH if exist "%LOCALAPPDATA%\Programs\videokit\resources\vendor\ffmpeg\bin\ffprobe.exe" set "FFPROBE_PATH=%LOCALAPPDATA%\Programs\videokit\resources\vendor\ffmpeg\bin\ffprobe.exe"
if not defined FFMPEG_PATH if exist "%~dp0..\ffmpeg.exe" set "FFMPEG_PATH=%~dp0..\ffmpeg.exe"
if not defined FFPROBE_PATH if exist "%~dp0..\ffprobe.exe" set "FFPROBE_PATH=%~dp0..\ffprobe.exe"

if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "node_modules\.bin\vite.cmd" goto install
goto ready

:install
echo [提示] 首次运行，正在安装依赖 (npm ci)...
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 (
    echo [提示] npm ci 失败，尝试 npm install...
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 goto failed
)

:ready
echo [启动] 正在启动 VideoKit (端口 %VITE_PORT%)...
echo [提示] 关闭软件窗口即可自动停止此后台服务。
echo.
call node_modules\.bin\concurrently.cmd --kill-others --success first "node node_modules/vite/bin/vite.js --host localhost" "node node_modules/wait-on/bin/wait-on --timeout 60000 http://localhost:%VITE_PORT% && node scripts/run-electron-dev.js"
if errorlevel 1 goto failed
popd
exit /b 0

:failed
echo.
echo [错误] VideoKit 启动失败，请查看上方报错信息。
pause
popd
exit /b 1
