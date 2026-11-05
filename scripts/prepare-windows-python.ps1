$ErrorActionPreference = 'Stop'
$version = '3.11.9'
$expectedSha256 = '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b'
$target = Join-Path $PSScriptRoot '../vendor/windows/python'
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('vkk-python-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $temporary | Out-Null
try {
    $archive = Join-Path $temporary 'python.zip'
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip" -OutFile $archive
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha256) {
        throw 'Embedded Python archive checksum mismatch'
    }
    New-Item -ItemType Directory -Force $target | Out-Null
    Expand-Archive -Path $archive -DestinationPath $target -Force
    New-Item -ItemType Directory -Force (Join-Path $target 'Lib/site-packages') | Out-Null
    @('python311.zip', '.', 'Lib/site-packages', 'import site') |
        Set-Content (Join-Path $target 'python311._pth') -Encoding ASCII
    & (Join-Path $target 'python.exe') -I -c 'import ctypes, encodings, json; print("Embedded Python runtime ready")'
    if ($LASTEXITCODE -ne 0) { throw 'Embedded Python could not load the export runtime' }
} finally {
    Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
