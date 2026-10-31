param(
  [string]$InstallerPath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
  $InstallerPath = Join-Path $repo "release-win\InspectorHub-Setup-$version.exe"
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$registryKey = 'HKCU:\Software\Classes\io.inspectorhub.app'
$registryCommand = Join-Path $registryKey 'shell\open\command'
$tempRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "InspectorHub-Smoke-$([guid]::NewGuid().ToString('N'))"))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Smoke directory escaped the system temporary directory.' }
$installDir = Join-Path $tempRoot 'installed'
$userData = Join-Path $tempRoot 'user-data'
$backupRegistry = Join-Path $tempRoot 'protocol-backup.reg'
$appProcess = $null
$registryWasPresent = Test-Path -LiteralPath $registryKey
$installed = $false

if ($registryWasPresent -and -not $Force) { throw 'The InspectorHub protocol handler already exists. Stop; pass -Force only if its current registry value is backed up for restoration.' }
New-Item -ItemType Directory -Path $tempRoot | Out-Null
if ($registryWasPresent) {
  & reg.exe export 'HKCU\Software\Classes\io.inspectorhub.app' $backupRegistry /y | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backupRegistry)) { throw 'Could not back up the existing protocol handler.' }
}

try {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited with code $($install.ExitCode)." }
  $installed = $true
  $exe = Join-Path $installDir 'InspectorHub.exe'
  $uninstaller = Join-Path $installDir 'Uninstall InspectorHub.exe'
  if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $uninstaller)) { throw 'Installer did not create the expected executable and uninstaller.' }

  New-Item -ItemType Directory -Path $userData | Out-Null
  Set-Content -LiteralPath (Join-Path $userData 'smoke-sentinel.txt') -Value 'user data must survive uninstall' -NoNewline
  $appProcess = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$userData" -PassThru
  $logPath = Join-Path $userData 'logs\main.log'
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $logPath) {
      if (Select-String -LiteralPath $logPath -Pattern 'window-ready' -Quiet) { break }
    }
    if ($appProcess.HasExited) { throw "InspectorHub exited before window-ready (code $($appProcess.ExitCode))." }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $logPath) -or -not (Select-String -LiteralPath $logPath -Pattern 'window-ready' -Quiet)) { throw 'Timed out waiting for window-ready.' }
  $protocolValue = (Get-Item -LiteralPath $registryCommand).GetValue('')
  if ($protocolValue -notlike "*$exe*") { throw 'The protocol handler does not point to the isolated installation.' }

  [void]$appProcess.CloseMainWindow()
  if (-not $appProcess.WaitForExit(15000)) { & taskkill.exe /PID $appProcess.Id /T /F | Out-Null }
  $appProcess = $null
  Start-Sleep -Milliseconds 500
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstall.ExitCode)." }
  $installed = $false
  if (Test-Path -LiteralPath $installDir) { throw 'The isolated installation directory remains after uninstall.' }
  if (-not $registryWasPresent -and (Test-Path -LiteralPath $registryKey)) { throw 'The protocol handler remains after uninstall.' }
  if (-not (Test-Path -LiteralPath (Join-Path $userData 'smoke-sentinel.txt'))) { throw 'User data did not survive uninstall.' }
  Write-Output 'Installer smoke passed: install, protocol registration, launch, window-ready, uninstall, and user-data preservation.'
}
finally {
  if ($appProcess -and -not $appProcess.HasExited) { & taskkill.exe /PID $appProcess.Id /T /F | Out-Null }
  if ($installed) {
    $uninstaller = Join-Path $installDir 'Uninstall InspectorHub.exe'
    if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait | Out-Null }
  }
  if ($registryWasPresent -and (Test-Path -LiteralPath $backupRegistry)) {
    Remove-Item -LiteralPath $registryKey -Recurse -Force -ErrorAction SilentlyContinue
    & reg.exe import $backupRegistry | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restore the pre-existing protocol registration.' }
  }
  elseif (-not $registryWasPresent -and (Test-Path -LiteralPath $registryKey)) {
    & reg.exe delete 'HKCU\Software\Classes\io.inspectorhub.app' /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to remove the protocol key created by this smoke run.' }
  }
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
    if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
  }
}
