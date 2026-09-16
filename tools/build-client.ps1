$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$webProject = Join-Path $projectRoot 'web-source'
Push-Location $webProject
try {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw '前端依賴安裝失敗' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '前端測試失敗' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '前端打包失敗' }
} finally { Pop-Location }
& (Join-Path $PSScriptRoot 'import-web-assets.ps1') -WebProject $webProject
