param(
    [Parameter(Mandatory = $true)]
    [string]$WebProject
)

$source = Join-Path $WebProject 'dist'
$index = Join-Path $source 'index.html'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = Join-Path $projectRoot 'app\src\main\assets\public'

if (-not (Test-Path -LiteralPath $index)) {
    throw "找不到 $index；請先在網頁專案執行 npm run build:android"
}

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
