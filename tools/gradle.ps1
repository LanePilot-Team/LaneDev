param(
    [ValidateSet('assembleDebug', 'assembleRelease', 'testDebugUnitTest', 'clean')]
    [string]$Task = 'assembleDebug'
)

$studioJdk = 'C:\Program Files\Android\Android Studio\jbr'
$androidSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'

if (-not (Test-Path (Join-Path $studioJdk 'bin\java.exe'))) {
    throw "找不到 Android Studio 內建 JDK：$studioJdk"
}
if (-not (Test-Path $androidSdk)) {
    throw "找不到 Android SDK：$androidSdk"
}

$env:JAVA_HOME = $studioJdk
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk

& (Join-Path $PSScriptRoot '..\gradlew.bat') $Task
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
