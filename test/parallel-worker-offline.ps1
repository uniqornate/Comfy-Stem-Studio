$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Net.Http
Add-Type -ReferencedAssemblies System.Net.Http.dll -TypeDefinition @'
using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
public sealed class LargeFixtureHandler : HttpMessageHandler {
 public static readonly byte[] Data = Enumerable.Range(0,32*1024*1024+9).Select(i=>(byte)(i%251)).ToArray();
 public static string Hash { get { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Data)).Replace("-","").ToLowerInvariant(); } }
 public int Calls, Ranges, NonRanges; public bool IgnoreRange;
 protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){
  Interlocked.Increment(ref Calls);
  if(request.Headers.Range==null || IgnoreRange){
   Interlocked.Increment(ref NonRanges);
   return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Data)});
  }
  Interlocked.Increment(ref Ranges);
  var range=request.Headers.Range.Ranges.Single();long start=range.From.Value,end=range.To.Value;
  var response=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(Data.Skip((int)start).Take((int)(end-start+1)).ToArray())};
  response.Content.Headers.ContentRange=new ContentRangeHeaderValue(start,end,Data.Length);
  return Task.FromResult(response);
 }
}
'@
. (Join-Path $project 'setup/Download-Worker.ps1')
$folder=Join-Path ([IO.Path]::GetTempPath()) ('StemStudio-LargeWorkerTest-'+[guid]::NewGuid().ToString('N'))
$file=[pscustomobject]@{path='fixture.bin';url='https://fixture.invalid/model';size=[LargeFixtureHandler]::Data.Length;algorithm='SHA256';hash=[LargeFixtureHandler]::Hash}
$packs=@([pscustomobject]@{id='fixture';files=@($file)})
function New-State{return [hashtable]::Synchronized(@{Cancel=$false;Running=$true;Done=$false;Success=$false;Bytes=[long]0;Total=[long]0;Status='';Error=''})}
try{
 $handler=New-Object LargeFixtureHandler;$state=New-State
 & $worker $state $packs $folder (Join-Path $project 'setup/Transfer.cs') $handler
 if(!$state.Success-or $handler.Ranges-ne 5-or $handler.NonRanges-ne 0){throw ('Worker did not use parallel ranges: '+$state.Error)}
 'PASS: real worker selects parallel path above 32 MiB, checks full hash and finalizes exact fixture.'
 [IO.File]::Delete((Join-Path $folder 'fixture.bin'))
 $handler=New-Object LargeFixtureHandler;$handler.IgnoreRange=$true;$state=New-State
 & $worker $state $packs $folder (Join-Path $project 'setup/Transfer.cs') $handler
 if(!$state.Success-or $handler.NonRanges-lt 2){throw ('Worker sequential fallback failed: '+$state.Error)}
 'PASS: real worker falls back safely when the server ignores ranges.'
 [IO.File]::Delete((Join-Path $folder 'fixture.bin'))
 $file.hash='0'*64;$handler=New-Object LargeFixtureHandler;$state=New-State
 & $worker $state $packs $folder (Join-Path $project 'setup/Transfer.cs') $handler
 if($state.Success-or $state.Error-notlike '*Integrity check failed*'-or @(Get-ChildItem -LiteralPath $folder -Filter '*.chunk-*').Count){throw ('Bad global hash was not cleaned: '+$state.Error)}
 'PASS: incorrect final hash rejects output and removes invalid chunk cache.'
}finally{
 # Delete only our exact known fixture files and hash-bound chunk names.
 if([IO.Directory]::Exists($folder)){
  foreach($item in Get-ChildItem -LiteralPath $folder -File){
   if($item.Name-eq 'fixture.bin'-or $item.Name-eq 'stem-studio-models.json'-or $item.Name-match '^fixture\.bin\.[a-f0-9]{64}\.part(\.lock|\.chunk-\d+-\d+)?$'){[IO.File]::Delete($item.FullName)}
  }
  [IO.Directory]::Delete($folder,$false)
 }
}
