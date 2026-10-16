$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source=Join-Path $project 'setup\QuietProcess.cs'
$target=Join-Path $project 'setup\QuietProcess.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$target" $source
if($LASTEXITCODE -ne 0){throw 'Hidden process host compilation failed.'}
Write-Output 'Hidden process host compiled. No executable was launched.'
