# Dot-source this file: . .\scripts\dev-env.ps1
# It changes the current shell only. It never edits global environment variables.
#
# Each location is read from the environment (JDK_HOME_21, ANDROID_HOME, GRADLE_USER_HOME,
# MAESTRO_HOME). To pin them for this checkout, create scripts/dev-env.local.ps1 (gitignored)
# and set the same variables there.

$JdkHome     = $env:JDK_HOME_21
$AndroidSdk  = $env:ANDROID_HOME
$GradleHome  = $env:GRADLE_USER_HOME
$MaestroHome = $env:MAESTRO_HOME

$local = Join-Path $PSScriptRoot 'dev-env.local.ps1'
if (Test-Path $local) { . $local }

if (-not $AndroidSdk -or -not (Test-Path $AndroidSdk)) { throw "Android SDK not found: $AndroidSdk (set `$AndroidSdk in scripts/dev-env.local.ps1)" }
if (-not $JdkHome -or -not (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) { throw "JDK 21 not found: $JdkHome (set `$JdkHome in scripts/dev-env.local.ps1)" }

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
