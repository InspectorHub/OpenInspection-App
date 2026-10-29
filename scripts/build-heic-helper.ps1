$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer vswhere.exe was not found.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($visualStudio)) { throw 'Visual Studio C++ x64 build tools were not found.' }
$vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'vcvars64.bat was not found.' }

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceFile = Join-Path $appRoot 'native\win-heic-helper\main.cpp'
$outputDirectory = Join-Path $appRoot 'dist-electron\native'
$outputFile = Join-Path $outputDirectory 'win-heic-helper.exe'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$compile = 'call "{0}" >nul && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /DUNICODE /D_UNICODE "{1}" /Fe:"{2}" ole32.lib oleaut32.lib windowscodecs.lib' -f $vcvars, $sourceFile, $outputFile
& $env:ComSpec /d /s /c $compile
if ($LASTEXITCODE -ne 0) { throw "HEIC helper build failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $outputFile)) { throw 'HEIC helper build did not produce the expected executable.' }
Write-Output "Built $outputFile"
