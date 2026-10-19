@echo off
setlocal
chcp 65001 >nul
set "VIDEOKIT_REPAIR_SELF=%~f0"
set "VIDEOKIT_REPAIR_CHECK=0"
if /i "%~1"=="--check" set "VIDEOKIT_REPAIR_CHECK=1"
powershell.exe -NoLogo -NoProfile -Command "$raw=[IO.File]::ReadAllText($env:VIDEOKIT_REPAIR_SELF,[Text.Encoding]::UTF8); $marker='#'+' VK_REPAIR_PAYLOAD'; $pos=$raw.LastIndexOf($marker); if($pos -lt 0){exit 1}; & ([scriptblock]::Create($raw.Substring($pos+$marker.Length))) -CheckOnly:($env:VIDEOKIT_REPAIR_CHECK -eq '1')"
set "VK_REPAIR_RC=%errorlevel%"
echo.
if "%VIDEOKIT_REPAIR_CHECK%"=="0" pause
exit /b %VK_REPAIR_RC%
# VK_REPAIR_PAYLOAD
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Write-Host 'VideoKit 安装版白屏修复（保留工程与定制功能）' -ForegroundColor Cyan
    Write-Host '只备份并重建 Code Cache，不替换程序、不删除个人数据。'
    Write-Host ''
    $running = @(Get-Process -Name VideoKit -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0 -and -not $CheckOnly) {
        Write-Host 'VideoKit 仍在运行，本次未修改任何文件。' -ForegroundColor Yellow
        Write-Host '请保存工程并完全关闭 VideoKit，然后再次双击本批处理。'
        Write-Host '如果白屏无法关闭，可先在任务管理器结束 VideoKit；未保存的改动可能丢失。'
        exit 2
    }
    $profiles = New-Object 'System.Collections.Generic.List[string]'
    $profiles.Add((Join-Path $env:APPDATA 'videokit'))
    $installDirs = @((Join-Path $env:LOCALAPPDATA 'Programs\videokit'))
    if ($env:ProgramFiles) { $installDirs += Join-Path $env:ProgramFiles 'VideoKit' }
    if (${env:ProgramFiles(x86)}) { $installDirs += Join-Path ${env:ProgramFiles(x86)} 'VideoKit' }
    if ($env:VIDEOKIT_REPAIR_SELF) { $installDirs += [IO.Path]::GetDirectoryName($env:VIDEOKIT_REPAIR_SELF) }
    foreach ($dir in $installDirs | Select-Object -Unique) {
        $config = Join-Path $dir '.videokit-cache-config.json'
        if (Test-Path -LiteralPath $config -PathType Leaf) {
            $settings = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($settings.userDataPath -and (Test-Path -LiteralPath $settings.userDataPath -PathType Container)) {
                $profiles.Add([string]$settings.userDataPath)
            }
        }
    }
    $renamed = 0
    foreach ($profile in $profiles | Select-Object -Unique) {
        $root = [IO.Path]::GetFullPath($profile).TrimEnd('\','/')
        $cache = [IO.Path]::GetFullPath((Join-Path $root 'Code Cache'))
        if (-not [string]::Equals([IO.Path]::GetDirectoryName($cache), $root, [StringComparison]::OrdinalIgnoreCase)) {
            throw '缓存路径校验失败，已停止。'
        }
        if (-not (Test-Path -LiteralPath $cache -PathType Container)) { continue }
        $item = Get-Item -LiteralPath $cache -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "代码缓存目录是链接，已停止以免操作错误位置：$cache"
        }
        if ($CheckOnly) {
            Write-Host "[仅检查，不修改] 找到代码缓存：$cache"
            $renamed++
            continue
        }
        $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
        $backupName = 'Code Cache.before-videokit-repair-' + $suffix
        Rename-Item -LiteralPath $cache -NewName $backupName
        Write-Host "已保留旧缓存：$(Join-Path $root $backupName)"
        $renamed++
    }
    Write-Host ''
    if ($CheckOnly) {
        Write-Host "检查结束：找到 $renamed 处代码缓存，没有修改任何文件。"
    } elseif ($renamed -gt 0) {
        Write-Host '代码缓存处理完成。现在请正常打开安装版 VideoKit。' -ForegroundColor Green
        Write-Host '首次打开会自动重建缓存，可能比平时稍慢。'
        Write-Host '工程、预设、设置及程序中的定制修改均未改动。'
    } else {
        Write-Host '未找到现有 Code Cache，本次没有修改文件。' -ForegroundColor Yellow
        Write-Host '请正常启动 VideoKit；若仍白屏，需要进一步检查启动日志。'
        Write-Host '若使用自定义安装/缓存位置，也可把批处理放到 VideoKit.exe 同目录再运行。'
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host ('处理未完成：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '请检查软件是否已退出及缓存目录是否可写；不要删除工程或重置个人配置。'
    exit 1
}

