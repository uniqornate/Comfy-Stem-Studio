$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$package=Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$output=Join-Path $project $package.build.directories.output
$core=Join-Path $output 'Stem-Studio-Core.exe'
$target=Join-Path $output 'Stem-Studio-Setup.exe'
if (!(Test-Path -LiteralPath $core)) { throw "Build the NSIS core first: $core" }
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework C# compiler is required on the Windows build host.' }
$generated=Join-Path $output 'bootstrap-build'
[IO.Directory]::CreateDirectory($generated) | Out-Null
$versionFile=Join-Path $generated 'version.json'
@{version=$package.version} | ConvertTo-Json | Set-Content -LiteralPath $versionFile -Encoding UTF8
$inputs=@{
 'Core.exe'=$core
 'Setup.ps1'=(Join-Path $PSScriptRoot 'bootstrap\UnifiedSetup.ps1')
 'Setup.xaml'=(Join-Path $PSScriptRoot 'bootstrap\Setup.xaml')
 'Download-Worker.ps1'=(Join-Path $project 'setup\Download-Worker.ps1')
 'Unified-Worker.ps1'=(Join-Path $project 'setup\Unified-Worker.ps1')
 'Transfer.cs'=(Join-Path $project 'setup\Transfer.cs')
 'models.json'=(Join-Path $project 'setup\models.json')
 'version.json'=$versionFile
}
# Static parsing only. Do not instantiate windows or execute the installer here.
foreach ($file in $inputs.Values | Where-Object { $_ -like '*.ps1' }) {
 $tokens=$null; $parseErrors=$null
 [System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$parseErrors) | Out-Null
 if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$xml=New-Object Xml.XmlDocument
$xml.Load($inputs['Setup.xaml'])
$arguments=@('/nologo','/target:winexe','/platform:x64','/optimize+','/reference:System.Windows.Forms.dll',"/out:$target",("/win32manifest:"+(Join-Path $PSScriptRoot 'bootstrap\app.manifest')))
foreach ($name in $inputs.Keys) { $arguments+="/resource:$($inputs[$name]),$name" }
$arguments+=(Join-Path $PSScriptRoot 'bootstrap\Launcher.cs')
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Custom setup launcher compilation failed.' }
# Read embedded resources as metadata only; never invoke the executable entry point.
$assembly=[Reflection.Assembly]::ReflectionOnlyLoadFrom($target)
$hasher=[Security.Cryptography.SHA256]::Create()
try {
 foreach ($name in $inputs.Keys) {
  $resource=$assembly.GetManifestResourceStream($name)
  if (!$resource) { throw "Missing embedded setup resource: $name" }
  try { $actual=[BitConverter]::ToString($hasher.ComputeHash($resource)).Replace('-','') } finally { $resource.Dispose() }
  $sourceStream=[IO.File]::OpenRead($inputs[$name])
  try { $expected=[BitConverter]::ToString($hasher.ComputeHash($sourceStream)).Replace('-','') } finally { $sourceStream.Dispose() }
  if ($actual -ne $expected) { throw "Embedded setup resource differs from source: $name" }
 }
} finally { $hasher.Dispose() }
$details=Get-Item -LiteralPath $target
Write-Output "All $($inputs.Count) embedded setup resources match source SHA-256 hashes. No executable was launched."
Write-Output "Custom setup built: $($details.FullName) ($($details.Length) bytes)"
