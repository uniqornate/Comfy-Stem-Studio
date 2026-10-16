$worker = {
 param($state, $packs, $folder, $transferSource, $httpHandler=$null, $reuseRoots=@())
 $ErrorActionPreference = 'Stop'
 Add-Type -AssemblyName System.Net.Http
 $client = if ($httpHandler) { New-Object Net.Http.HttpClient($httpHandler) } else { New-Object Net.Http.HttpClient }
 $client.Timeout = [TimeSpan]::FromMinutes(120)
 $client.DefaultRequestHeaders.UserAgent.ParseAdd('StemStudio/0.4.1')
 $client.DefaultRequestHeaders.CacheControl=New-Object Net.Http.Headers.CacheControlHeaderValue
 $client.DefaultRequestHeaders.CacheControl.NoCache=$true
 $cancelSource = New-Object Threading.CancellationTokenSource
 $stream = $null; $output = $null; $response = $null; $part = $null; $copy = $null; $lock = $null; $lockPath=$null
 try {
  if (!('StemStudio.Setup.ModelTransfer' -as [type])) { Add-Type -Path $transferSource -ReferencedAssemblies System.Net.Http.dll }
  function Test-ModelHash($path,$entry) {
   if ([StemStudio.Setup.ModelTransfer]::HashFile($path,$entry.algorithm) -ne $entry.hash) { return $false }
   if ($entry.sha256 -and [StemStudio.Setup.ModelTransfer]::HashFile($path,'SHA256') -ne $entry.sha256) { return $false }
   return $true
  }
  $root = [IO.Path]::GetFullPath($folder).TrimEnd('\') + '\'
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $files = @($packs | ForEach-Object { $_.files })
  $state.Total = [long](($files | Measure-Object size -Sum).Sum)
  $completed = [long]0
  foreach ($file in $files) {
   if ($state.Cancel) { throw 'Download cancelled.' }
   $target = [IO.Path]::GetFullPath((Join-Path $root $file.path))
   if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid model destination.' }
   if (([uri]$file.url).Scheme -ne 'https') { throw 'Only HTTPS model sources are allowed.' }
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
   if (![IO.File]::Exists($target)) {
    foreach ($reuseRoot in $reuseRoots) {
     $candidate=Join-Path $reuseRoot $file.path
     if ([IO.File]::Exists($candidate) -and (Get-Item -LiteralPath $candidate).Length -eq $file.size) {
      $state.Status="Verifying previously downloaded $($file.path)"
      if (Test-ModelHash $candidate $file) {
       $state.Status="Reusing verified $($file.path) in ComfyUI models"
       # Keep final paths absent until the copied legacy file is complete and verified.
       $reused="$target.$($file.hash).reuse"
       [IO.File]::Copy($candidate,$reused,$true)
       if (!(Test-ModelHash $reused $file)) { throw "Copied model failed verification: $($file.path). Retry preparation." }
       [IO.File]::Move($reused,$target)
       break
      }
     }
    }
   }
   if ([IO.File]::Exists($target)) {
    $state.Status = "Checking existing $($file.path)"
    if ((Get-Item -LiteralPath $target).Length -ne $file.size -or !(Test-ModelHash $target $file)) { throw "Existing file differs from manifest: $target. Move it aside before retrying; it has not been overwritten." }
    $completed += [long]$file.size; $state.Bytes = $completed; continue
   }
   $part = "$target.$($file.hash).part"
   $lockPath="$part.lock"
   try { $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Write,[IO.FileShare]::None) }
   catch { throw "Another download may be using $($file.path). Close the other installer before retrying." }
   $offset=if ([IO.File]::Exists($part)) { (Get-Item -LiteralPath $part).Length } else { [long]0 }
   if ($offset -gt [long]$file.size) { [IO.File]::Delete($part); $offset=[long]0 }
   $state.Rate=[double]0; $state.Eta=[double]-1
   $state.Bytes=$completed+$offset
   if ($offset -lt [long]$file.size -and [long]$file.size -ge 32MB) {
    $parallel=New-Object StemStudio.Setup.ParallelModelDownload
    $sources=[string[]](@($file.url)+@($file.fallbackUrls | Where-Object { $_ }))
    $state.Status="Preparing parallel download for $($file.path)"
    $copy=$parallel.DownloadAsync($client,$sources,$part,[long]$file.size,$cancelSource.Token,4,8MB,12000,256KB)
    $watch=[Diagnostics.Stopwatch]::StartNew();$sampleAt=[double]0;$sampleBytes=[long]0
    try {
     while(!$copy.IsCompleted){
      if($state.Cancel){$cancelSource.Cancel()}
      $null=([IAsyncResult]$copy).AsyncWaitHandle.WaitOne(100)
      $state.Bytes=$completed+$parallel.Bytes
      $state.Status="$($file.path): $($parallel.Status)"
      $now=$watch.Elapsed.TotalSeconds
      if($now-$sampleAt-ge 0.5){
       $rate=[Math]::Max(0,($parallel.NetworkBytes-$sampleBytes)/($now-$sampleAt))
       $state.Rate=if($state.Rate-gt 0){0.65*$state.Rate+0.35*$rate}else{$rate}
       $state.Eta=if($state.Rate-gt 0){($state.Total-$state.Bytes)/$state.Rate}else{-1}
       $sampleAt=$now;$sampleBytes=$parallel.NetworkBytes
      }
     }
     $null=$copy.GetAwaiter().GetResult()
     $offset=[long]$file.size;$state.Bytes=$completed+$offset
    } catch {
     if(!$state.Cancel-and $_.Exception.ToString()-like '*Range requests unsupported*'){
      $state.Status="Source does not support parallel ranges; resuming $($file.path) with one connection"
      $offset=if([IO.File]::Exists($part)){(Get-Item -LiteralPath $part).Length}else{[long]0}
     }else{throw}
    } finally {$copy=$null}
   }
   if ($offset -lt [long]$file.size) {
   $sources=@($file.url)+@($file.fallbackUrls | Where-Object { $_ })
   foreach ($source in $sources) {
    if (([uri]$source).Scheme -ne 'https') { throw 'Only HTTPS model sources are allowed.' }
    $hostName=([uri]$source).Host
    $state.Status = "Downloading $($file.path) from $hostName"
    if ($offset) { $state.Status+=" (resuming)" }
    $message=New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get,$source)
    $message.Headers.AcceptEncoding.ParseAdd('identity')
    if ($offset) { $message.Headers.Range=New-Object Net.Http.Headers.RangeHeaderValue([long]$offset,$null) }
    try {
     $request=$client.SendAsync($message,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancelSource.Token)
     while (!$request.IsCompleted) { if ($state.Cancel) { $cancelSource.Cancel(); throw 'Download cancelled.' }; $null=([IAsyncResult]$request).AsyncWaitHandle.WaitOne(100) }
     $response=$request.GetAwaiter().GetResult()
    } catch {
     if ($cancelSource.IsCancellationRequested -or $source -eq $sources[-1]) { throw }
     continue
    } finally { $message.Dispose() }
    if ($response.IsSuccessStatusCode) { break }
    $code=[int]$response.StatusCode
    $response.Dispose(); $response=$null
    if ($source -eq $sources[-1]) {
     $help=if ($code -eq 403) { 'The source refused access. Try its published page in your browser or retry later.' } elseif ($code -eq 429) { 'The source is rate-limiting requests. Wait before retrying.' } else { 'Check the source availability and retry.' }
     throw "Could not download $($file.path) from $hostName (HTTP $code). $help"
    }
   }
   $code=[int]$response.StatusCode
   if ($code -eq 206) {
    $range=$response.Content.Headers.ContentRange
    if (!$range -or $range.From -ne $offset -or $range.Length -ne [long]$file.size -or $range.To -ne ([long]$file.size-1)) { throw 'The server returned an invalid resume range. Partial data was preserved.' }
   } elseif ($code -eq 200) { $offset=[long]0 } # Server ignores Range: safely restart our own partial file.
   else { throw "Unexpected download response HTTP $code." }
   if ($response.Content.Headers.ContentLength -ne $null -and $response.Content.Headers.ContentLength -ne ([long]$file.size-$offset)) { throw 'The response size differs from the expected remaining bytes.' }
   $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
   $mode=if ($offset) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
   $output = [IO.File]::Open($part, $mode, [IO.FileAccess]::Write,[IO.FileShare]::None)
   $transfer=New-Object StemStudio.Setup.ModelTransfer
   $copy=$transfer.CopyAsync($stream, $output, ([long]$file.size-$offset), $cancelSource.Token, 60000)
   $watch=[Diagnostics.Stopwatch]::StartNew(); $sampleAt=[double]0; $sampleBytes=[long]0
   while (!$copy.IsCompleted) {
    if ($state.Cancel) { $cancelSource.Cancel() }
    # This waits on the entire native transfer, never on individual network chunks.
    $null=([IAsyncResult]$copy).AsyncWaitHandle.WaitOne(100)
    $state.Bytes=$completed+$offset+$transfer.Bytes
    $now=$watch.Elapsed.TotalSeconds
    if ($now-$sampleAt -ge 0.5) {
     $rate=($transfer.Bytes-$sampleBytes)/($now-$sampleAt)
     $state.Rate=if ($state.Rate -gt 0) { 0.65*$state.Rate+0.35*$rate } else { $rate }
     $state.Eta=if ($state.Rate -gt 0) { ($state.Total-$state.Bytes)/$state.Rate } else { -1 }
     $sampleAt=$now; $sampleBytes=$transfer.Bytes
    }
   }
   $null=$copy.GetAwaiter().GetResult(); $copy=$null
   $state.Bytes=$completed+$offset+$transfer.Bytes
   $output.Dispose(); $output=$null; $stream.Dispose(); $stream=$null; $response.Dispose(); $response=$null
   }
   $state.Status = "Verifying $($file.path)"
   $state.Rate=[double]0; $state.Eta=[double]-1
   if ((Get-Item -LiteralPath $part).Length -ne [long]$file.size -or !(Test-ModelHash $part $file)) { [IO.File]::Delete($part); [StemStudio.Setup.ParallelModelDownload]::CleanChunks($part); throw "Integrity check failed: $($file.path). Invalid partial data was removed; retry to download a fresh copy." }
   if ($state.Cancel) { throw 'Download cancelled.' }
   [StemStudio.Setup.ParallelModelDownload]::CleanChunks($part)
   [IO.File]::Move($part, $target); $part=$null
   $lock.Dispose(); $lock=$null
   try { [IO.File]::Delete($lockPath) } catch { }; $lockPath=$null
   $completed += [long]$file.size; $state.Bytes=$completed
  }
  $receipt = @{ installedAt=[DateTime]::UtcNow.ToString('o'); packs=@($packs.id); files=$files; inferenceReady=$false }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'stem-studio-models.json') -Encoding UTF8
  $state.Success=$true; $state.Status='Selected model files verified.'
 } catch {
  $state.Error=$_.Exception.Message
  if ($file -and $state.Error -notlike "*$($file.path)*") { $state.Error="$($file.path): $($state.Error)" }
  $state.Status='Model preparation incomplete.'
 }
 finally {
  $cancelSource.Cancel()
  if ($copy -and !$copy.IsCompleted) { try { if($stream){$stream.Dispose()}; $copy.GetAwaiter().GetResult() } catch { } }
  if ($output) { $output.Dispose() }; if ($stream) { $stream.Dispose() }; if ($response) { $response.Dispose() }
  # Keep hash-bound partial data on interruption; final size and hashes remain mandatory.
  if ($lock) { $lock.Dispose() }
  if ($lockPath) { try { [IO.File]::Delete($lockPath) } catch { } }
  $client.Dispose(); $cancelSource.Dispose(); $state.Running=$false; $state.Done=$true
 }
}


