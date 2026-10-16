$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Net.Http
Add-Type -ReferencedAssemblies System.Net.Http.dll -TypeDefinition @'
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Net.Http.Headers;
using System.IO;
public sealed class InterruptedFixtureStream : MemoryStream {
 public InterruptedFixtureStream() : base(new byte[]{97,98}) { }
 public override Task<int> ReadAsync(byte[] buffer,int offset,int count,CancellationToken token) {
  if(Position<Length) return Task.FromResult(Read(buffer,offset,count));
  var failure=new TaskCompletionSource<int>(); failure.SetException(new IOException("Simulated connection loss.")); return failure.Task;
 }
}
public sealed class OfflineDownloadHandler : HttpMessageHandler {
 public int Code = 200;
 public int Calls = 0;
 public bool Identified = false;
 public bool SawRange = false;
 public bool IgnoreRange = false;
 public bool InvalidRange = false;
 public bool FailFirst = false;
 public bool Interrupt = false;
 protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
  Calls++;
  Identified = request.Headers.UserAgent.ToString().Contains("StemStudio/");
  long offset=0;
  if (request.Headers.Range != null) { SawRange=true; foreach(var range in request.Headers.Range.Ranges) offset=range.From.GetValueOrDefault(); }
  bool partial=SawRange && !IgnoreRange;
  int status=(FailFirst && Calls==1) ? 403 : Code;
  if(status==200 && partial) status=206;
  var response = new HttpResponseMessage((HttpStatusCode)status);
  response.Content = new ByteArrayContent(partial ? new byte[]{99} : new byte[]{97,98,99});
  if(Interrupt) { response.Content=new StreamContent(new InterruptedFixtureStream()); response.Content.Headers.ContentLength=3; }
  if(partial) response.Content.Headers.ContentRange=new ContentRangeHeaderValue(InvalidRange ? 0 : offset,2,3);
  return Task.FromResult(response);
 }
}
'@
. (Join-Path $project 'setup\Download-Worker.ps1')
$folder=Join-Path ([IO.Path]::GetTempPath()) ('StemStudio-WorkerTest-'+[guid]::NewGuid().ToString('N'))
$file=[pscustomobject]@{path='fixture.bin';url='https://example.invalid/fixture.bin';size=3;algorithm='SHA256';hash='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}
$packs=@([pscustomobject]@{id='fixture';files=@($file)})
$transfer=Join-Path $project 'setup\Transfer.cs'
$partial=Join-Path $folder ('fixture.bin.'+$file.hash+'.part')
$target=Join-Path $folder 'fixture.bin'
function New-State { return [hashtable]::Synchronized(@{Cancel=$false;Running=$true;Done=$false;Success=$false;Bytes=[long]0;Total=[long]0;Status='';Error=''}) }
try {
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.Code=403
 & $worker $state $packs $folder $transfer $handler
 if ($state.Success -or !$state.Done -or $state.Error -notlike '*fixture.bin*HTTP 403*' -or !$handler.Identified) { throw ('403 diagnostics failed: '+$state.Error) }
 Write-Output 'PASS: mocked HTTP 403 identifies file/source/status and sends an application User-Agent.'
 if (@(Get-ChildItem -LiteralPath $folder -Filter '*.part').Count) { throw 'HTTP failure left partial data.' }
 $state=New-State; $handler=New-Object OfflineDownloadHandler
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or $handler.Calls -ne 1 -or (Get-Item -LiteralPath (Join-Path $folder 'fixture.bin')).Length -ne 3) { throw ('Mocked transfer failed: '+$state.Error) }
 Write-Output 'PASS: in-memory HTTP response streams, verifies and finalizes a three-byte fixture.'
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.Code=403
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or $handler.Calls -ne 0) { throw ('Verified file reuse failed: '+$state.Error) }
 Write-Output 'PASS: an existing verified fixture is reused without requesting the source.'
 [IO.File]::Delete($target)
 [IO.File]::WriteAllBytes($partial,[byte[]]@(97,98))
 $state=New-State; $handler=New-Object OfflineDownloadHandler
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or !$handler.SawRange) { throw ('Valid resume failed: '+$state.Error) }
 Write-Output 'PASS: partial data resumes with Range and final hash verification.'
 [IO.File]::Delete($target)
 [IO.File]::WriteAllBytes($partial,[byte[]]@(97,98))
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.IgnoreRange=$true
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or !$handler.SawRange) { throw ('Ignored-range restart failed: '+$state.Error) }
 Write-Output 'PASS: server ignoring Range restarts safely instead of appending a full response.'
 [IO.File]::Delete($target)
 [IO.File]::WriteAllBytes($partial,[byte[]]@(97,98))
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.InvalidRange=$true
 & $worker $state $packs $folder $transfer $handler
 if ($state.Success -or (Get-Item -LiteralPath $partial).Length -ne 2 -or $state.Error -notlike '*invalid resume range*') { throw ('Invalid range was not rejected: '+$state.Error) }
 Write-Output 'PASS: invalid range is rejected and the existing partial is preserved.'
 [IO.File]::WriteAllBytes($partial,[byte[]]@(97,98,99))
 $state=New-State; $handler=New-Object OfflineDownloadHandler
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or $handler.Calls -ne 0) { throw ('Complete partial reuse failed: '+$state.Error) }
 Write-Output 'PASS: a complete partial verifies and finalizes without an HTTP request.'
 [IO.File]::Delete($target)
 [IO.File]::WriteAllBytes($partial,[byte[]]@(120,98))
 $state=New-State; $handler=New-Object OfflineDownloadHandler
 & $worker $state $packs $folder $transfer $handler
 if ($state.Success -or [IO.File]::Exists($partial) -or [IO.File]::Exists($target)) { throw 'Corrupt resumed bytes were accepted.' }
 Write-Output 'PASS: corrupt resumed data fails final hash and is removed.'
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.Interrupt=$true
 & $worker $state $packs $folder $transfer $handler
 if ($state.Success -or !(Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -ne 2) { throw ('Interrupted partial was not preserved: '+$state.Error) }
 Write-Output 'PASS: connection loss preserves bytes already written for a later retry.'
 $state=New-State; $handler=New-Object OfflineDownloadHandler
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or !$handler.SawRange) { throw ('Interrupted transfer retry failed: '+$state.Error) }
 Write-Output 'PASS: retry resumes an actually interrupted fixture and verifies the full hash.'
 [IO.File]::Delete($target)
 $file | Add-Member -NotePropertyName fallbackUrls -NotePropertyValue @('https://backup.invalid/fixture.bin')
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.FailFirst=$true
 & $worker $state $packs $folder $transfer $handler
 if (!$state.Success -or $handler.Calls -ne 2) { throw ('Fallback failed: '+$state.Error) }
 Write-Output 'PASS: HTTP failure selects the configured fallback and verifies the same file.'
 $legacy=Join-Path $folder 'legacy'
 [IO.Directory]::CreateDirectory($legacy)|Out-Null
 [IO.File]::WriteAllBytes((Join-Path $legacy 'fixture.bin'),[byte[]]@(97,98,99))
 [IO.File]::Delete($target)
 $state=New-State; $handler=New-Object OfflineDownloadHandler; $handler.Code=403
 & $worker $state $packs $folder $transfer $handler @($legacy)
 if (!$state.Success -or $handler.Calls -ne 0 -or ![IO.File]::Exists((Join-Path $legacy 'fixture.bin'))) { throw ('Legacy reuse failed: '+$state.Error) }
 Write-Output 'PASS: verified legacy model is copied into the new category without network or deleting the old file.'
} finally {
 # Only these exact fixture files were created under our random temporary folder.
 foreach ($name in @('fixture.bin','stem-studio-models.json')) { $path=Join-Path $folder $name; if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
 foreach ($path in @($partial,"$partial.lock")) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
 $legacy=Join-Path $folder 'legacy'
 if([IO.File]::Exists((Join-Path $legacy 'fixture.bin'))){[IO.File]::Delete((Join-Path $legacy 'fixture.bin'))}
 if([IO.Directory]::Exists($legacy)){[IO.Directory]::Delete($legacy,$false)}
 if ([IO.Directory]::Exists($folder)) { [IO.Directory]::Delete($folder, $false) }
}
