$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer vswhere.exe was not found.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($visualStudio)) { throw 'Visual Studio C++ x64 build tools were not found.' }
$vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'vcvars64.bat was not found.' }

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceFile = Join-Path $appRoot 'e2e-electron\fixtures\heic-codec-missing.cpp'
$outputDirectory = Join-Path $appRoot '.superpowers\sdd\plan-d2-windows-electron'
$outputFile = Join-Path $outputDirectory 'helper-codec-missing.exe'
$objectFile = Join-Path $outputDirectory 'helper-codec-missing.obj'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$compile = 'call "{0}" >nul && cl.exe /nologo /EHsc /O2 /W4 "{1}" /Fo:"{2}" /Fe:"{3}"' -f $vcvars, $sourceFile, $objectFile, $outputFile
& $env:ComSpec /d /s /c $compile
if ($LASTEXITCODE -ne 0) { throw "E2E HEIC helper build failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $outputFile)) { throw 'E2E HEIC helper build did not produce the expected executable.' }
Write-Output "Built $outputFile"
