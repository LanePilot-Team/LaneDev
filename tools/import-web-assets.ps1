param(
    [Parameter(Mandatory = $true)]
    [string]$WebProject
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $WebProject 'dist'
$index = Join-Path $source 'index.html'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = Join-Path $projectRoot 'app\src\main\assets\public'

if (-not (Test-Path -LiteralPath $index)) {
    throw "找不到 $index；請先在 web-source 執行 npm run build"
}

$policyPath = Join-Path $source 'client-policy.json'
if (-not (Test-Path -LiteralPath $policyPath)) {
    throw '請使用本工作區 web-source 的 npm run build；禁止直接匯入開發版網頁資源。'
}
$policy = Get-Content -Raw -LiteralPath $policyPath | ConvertFrom-Json
if ($policy.format -ne 'lanedev-android-client-v1' -or $policy.editor -ne $false -or
    $policy.simulation -ne $false -or $policy.transit -ne $false) {
    throw '此資源包未通過 Android 用戶端功能限制檢查'
}
$scriptFiles = @(Get-ChildItem -LiteralPath (Join-Path $source 'assets') -Filter '*.js' -File)
if ($scriptFiles.Count -eq 0 -or $scriptFiles.Count -ne @($policy.scripts.PSObject.Properties).Count) {
    throw '客戶端程式檔案清單不符'
}
foreach ($scriptFile in $scriptFiles) {
    $hash = (Get-FileHash -LiteralPath $scriptFile.FullName -Algorithm SHA256).Hash
    if ($hash -ne $policy.scripts.($scriptFile.Name)) { throw "程式檔案未通過驗證：$($scriptFile.Name)" }
}
if (Test-Path -LiteralPath (Join-Path $source 'data/transit.json')) { throw '客戶端不可包含大眾運輸資料' }

$resolvedSource = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $source))
$resolvedTarget = [System.IO.Path]::GetFullPath($target)
if ($resolvedSource -eq $resolvedTarget) {
    throw '來源與 Android assets 目錄不可相同'
}
if (-not $resolvedTarget.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Android assets 目錄超出專案根目錄，拒絕更新'
}

if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}
Copy-Item -LiteralPath $resolvedSource -Destination $resolvedTarget -Recurse
Write-Output "已更新 Android assets：$resolvedTarget"
