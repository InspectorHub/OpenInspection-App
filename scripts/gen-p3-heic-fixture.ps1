$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scratchRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('oi-p3-fixture-' + [guid]::NewGuid().ToString('N'))
$profilePath = Join-Path $scratchRoot 'display-p3-test-cc0.icc'
$objectPath = Join-Path $scratchRoot 'encode-p3-heif-fixture.obj'
$exePath = Join-Path $scratchRoot 'encode-p3-heif-fixture.exe'
$outputPath = Join-Path $repoRoot 'src\media\heic\fixtures\fixture-p3.heic'

New-Item -ItemType Directory -Force -Path $scratchRoot | Out-Null
try {
  & python (Join-Path $PSScriptRoot 'gen-p3-test-profile.py') $profilePath
  if ($LASTEXITCODE -ne 0) { throw "Profile generation failed with exit code $LASTEXITCODE." }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer vswhere.exe was not found.' }
  $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($visualStudio)) { throw 'Visual Studio C++ x64 build tools were not found.' }
  $vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars64.bat'
  if (-not (Test-Path -LiteralPath $vcvars)) { throw 'vcvars64.bat was not found.' }

  $sourcePath = Join-Path $PSScriptRoot 'encode-p3-heif-fixture.cpp'
  $compile = 'call "{0}" >nul && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 "{1}" /Fo:"{2}" /Fe:"{3}" ole32.lib oleaut32.lib windowscodecs.lib' -f $vcvars, $sourcePath, $objectPath, $exePath
  & $env:ComSpec /d /s /c $compile
  if ($LASTEXITCODE -ne 0) { throw "Fixture encoder build failed with exit code $LASTEXITCODE." }

  & $exePath $profilePath $outputPath
  if ($LASTEXITCODE -ne 0) { throw "Fixture encoding failed with exit code $LASTEXITCODE." }
  Write-Output "Generated $outputPath"
} finally {
  Remove-Item -LiteralPath $scratchRoot -Recurse -Force -ErrorAction SilentlyContinue
}
