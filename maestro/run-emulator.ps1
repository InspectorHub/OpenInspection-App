# Runs the Maestro flows in this directory against an Android emulator that already runs the debug build,
# with the OpenInspection engine on this computer. See docs/development.md, "End-to-end flows with Maestro".
#
#   . .\scripts\dev-env.ps1
#   $env:OI_E2E_EMAIL = '<account on the local engine>'
#   $env:OI_E2E_PASSWORD = '<its password>'      # session only; never written to a file
#   .\maestro\run-emulator.ps1
#
# The flows run in order and depend on each other (sign in, seed, look, move the clock, lock). The emulator is left with
# automatic date and time switched back on, whatever happened.
param(
  [string]$ServerUrl = 'http://localhost:8787',
  [int]$LockDays = 31
)
$ErrorActionPreference = 'Stop'

foreach ($name in 'OI_E2E_EMAIL', 'OI_E2E_PASSWORD') {
  if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue)) { throw "Set $name in this shell first (it is read from the environment only)." }
}
foreach ($tool in 'adb', 'maestro') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. Run . .\scripts\dev-env.ps1 first." }
}

$devices = @(& adb devices | Select-String -Pattern '^emulator-\d+\s+device$')
if ($devices.Count -ne 1) { throw "Expected exactly one running emulator, found $($devices.Count)." }
# A phone may be plugged in too: pin adb and Maestro to the emulator for this process.
$serial = ($devices[0].ToString() -split '\s+')[0]
$env:ANDROID_SERIAL = $serial
$installed = & adb shell pm list packages io.inspectorhub.app
if (-not ($installed -match 'package:io.inspectorhub.app')) { throw 'The debug build is not installed on the emulator (cap sync, assembleDebug, adb install -r).' }

& adb reverse tcp:8787 tcp:8787 | Out-Null
$engine = (& curl.exe -s -o NUL -w '%{http_code}' "$ServerUrl/status")
if ($engine -ne '200') { throw "The engine did not answer $ServerUrl/status with 200 (got '$engine'). Start it with NATIVE_CLIENT_ENABLED=1." }

function Invoke-Flow([string]$file) {
  Write-Host "== $file"
  & maestro --device $serial test -e "SERVER_URL=$ServerUrl" -e "E2E_EMAIL=$env:OI_E2E_EMAIL" -e "E2E_PASSWORD=$env:OI_E2E_PASSWORD" (Join-Path $PSScriptRoot $file)
  if ($LASTEXITCODE -ne 0) { throw "$file failed (exit $LASTEXITCODE)." }
}

try {
  Invoke-Flow '01-sign-in.yaml'
  Invoke-Flow '02-seed-and-needs-attention.yaml'
  Invoke-Flow '03-settings-photos-not-attached.yaml'

  & adb root | Out-Null
  & adb shell settings put global auto_time 0
  & adb shell settings put global auto_time_zone 0
  $target = [DateTime]::UtcNow.AddDays($LockDays).ToString('MMddHHmmyyyy.ss')
  & adb shell date -u $target | Out-Null
  Invoke-Flow '04-lock-two-step-clear.yaml'
}
finally {
  & adb shell cmd connectivity airplane-mode disable | Out-Null
  & adb shell settings put global auto_time 1
  & adb shell settings put global auto_time_zone 1
  Write-Host 'Automatic date and time are on again; the emulator may need a minute to follow the network clock.'
}
