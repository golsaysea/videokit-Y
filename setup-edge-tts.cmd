@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1

echo [信息] VideoKit 已内置纯 Node.js 微软 Edge-TTS 引擎，无需安装 Python 即可直接在软件中使用微软配音！
echo [信息] 正在为您检测可选的 Python 备用环境...

if exist ".venv-edge\Scripts\python.exe" goto install

set "FOUND_PY="
for %%P in (
    "%LocalAppData%\Programs\Python\Python313\python.exe"
    "%LocalAppData%\Programs\Python\Python312\python.exe"
    "%LocalAppData%\Programs\Python\Python311\python.exe"
    "%LocalAppData%\Programs\Python\Python310\python.exe"
    "%LocalAppData%\Programs\videokit\resources\vendor\python\python.exe"
) do (
    if not defined FOUND_PY if exist "%%~P" (
        "%%~P" -c "import venv" >nul 2>&1
        if not errorlevel 1 set "FOUND_PY=%%~P"
    )
)

if defined FOUND_PY (
    echo [信息] 检测到可用 Python: "!FOUND_PY!"
    "!FOUND_PY!" -m venv .venv-edge
    if not errorlevel 1 goto install
)

where py.exe >nul 2>&1
if not errorlevel 1 (
    for %%V in (3.13 3.12 3.11 3.10) do (
        py -%%V -c "import venv" >nul 2>&1
        if not errorlevel 1 (
            py -%%V -m venv .venv-edge
            if not errorlevel 1 goto install
        )
    )
)

echo [完成] 已启用内置 Node.js 免 Python 微软配音引擎，无需配置 .venv-edge，可直接在软件中使用！
popd
exit /b 0

:install
".venv-edge\Scripts\python.exe" -m pip install -r requirements-edge.txt --disable-pip-version-check
if errorlevel 1 goto fallback_ready
".venv-edge\Scripts\python.exe" -c "import edge_tts; print('Edge speech is ready.')"
if errorlevel 1 goto fallback_ready
popd
exit /b 0

:fallback_ready
echo [提示] Python 虚拟环境可选依赖跳过，已启用内置 Node.js 免 Python 微软配音引擎！
popd
exit /b 0