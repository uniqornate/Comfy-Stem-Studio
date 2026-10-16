$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Net.Http
Add-Type -Path @((Join-Path $project 'setup/Transfer.cs'),(Join-Path $PSScriptRoot 'ParallelDownloadOffline.cs')) -ReferencedAssemblies System.Net.Http.dll
[ParallelDownloadOffline]::Run()
