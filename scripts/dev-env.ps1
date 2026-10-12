# Dot-source this file: . .\scripts\dev-env.ps1
# It changes the current shell only. It never edits global environment variables.
#
# Defaults below match the reference setup (JDK and SDK on D:). To override them on your
# machine, create scripts/dev-env.local.ps1 (gitignored) and set the same variables there.

$JdkHome    = 'D:\DevTools\jdk-21'
$AndroidSdk = 'D:\Android\Sdk'
$GradleHome = 'D:\DevTools\gradle-home'
$MaestroHome = 'D:\DevTools\maestro'

$local = Join-Path $PSScriptRoot 'dev-env.local.ps1'
if (Test-Path $local) { . $local }

if (-not (Test-Path $AndroidSdk)) { throw "Android SDK not found: $AndroidSdk (set `$AndroidSdk in scripts/dev-env.local.ps1)" }
if (-not (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) { throw "JDK 21 not found: $JdkHome (set `$JdkHome in scripts/dev-env.local.ps1)" }

$env:JAVA_HOME        = $JdkHome
$env:ANDROID_HOME     = $AndroidSdk
$env:GRADLE_USER_HOME = $GradleHome
$env:Path = "$JdkHome\bin;$AndroidSdk\platform-tools;$AndroidSdk\cmdline-tools\latest\bin;$env:Path"
if (Test-Path "$MaestroHome\bin") { $env:Path = "$MaestroHome\bin;$env:Path" }

# `java -version` writes to stderr; Windows PowerShell 5.1 wraps that as an error record.
# Read the text instead of trusting the exit code.
$javaLine = (& cmd /c 'java -version 2>&1' | Select-Object -First 1)
Write-Host "java:  $javaLine"
Write-Host "sdk:   $env:ANDROID_HOME"
& adb devices
