$unifiedWorker = {
 param($state,$packs,$modelRoot,$transferPath,$legacyRoot,$appDir,$comfyRoot,$comfyUrl,$allowRestart,$workDir,$installParent,$gpu)
 $ErrorActionPreference='Stop'
 $process=$null
 try {
  . (Join-Path (Split-Path $transferPath -Parent) 'Download-Worker.ps1')
  if ($installParent) {
   $state.Phase='comfy'; $state.Percent=0; $state.Status='Installing ComfyUI'; $state.Detail='Preparing the download.'
   $comfyStatus=Join-Path $workDir 'comfy-status.json'; $comfyResult=Join-Path $workDir 'comfy-result.json'; $comfyCancel=Join-Path $workDir 'comfy-cancel'
   foreach($path in @($comfyStatus,$comfyResult,$comfyCancel)){ if([IO.File]::Exists($path)){[IO.File]::Delete($path)} }
   $comfyConfig=@{parent=$installParent;gpu=$gpu;statusFile=$comfyStatus;resultFile=$comfyResult;cancelFile=$comfyCancel}
   $comfyConfigFile=Join-Path $workDir 'comfy-config.json'
   [IO.File]::WriteAllText($comfyConfigFile,($comfyConfig|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)))
   $comfyStart=New-Object Diagnostics.ProcessStartInfo
   $comfyStart.FileName=Join-Path $appDir 'Stem Studio.exe'
   $comfyStart.Arguments='"'+(Join-Path $appDir 'resources\setup\comfy-install.mjs')+'" "'+$comfyConfigFile+'"'
   $comfyStart.UseShellExecute=$false; $comfyStart.CreateNoWindow=$true; $comfyStart.WindowStyle='Hidden'
   $comfyStart.RedirectStandardError=$true; $comfyStart.RedirectStandardOutput=$true
   $comfyStart.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
   $comfyStart.EnvironmentVariables['STEM_QUIET_PROCESS']=Join-Path $appDir 'resources\setup\QuietProcess.exe'
   $comfyProcess=[Diagnostics.Process]::Start($comfyStart)
   $comfyErr=$comfyProcess.StandardError.ReadToEndAsync(); $comfyOut=$comfyProcess.StandardOutput.ReadToEndAsync()
   while(!$comfyProcess.WaitForExit(250)) {
    if($state.Cancel -and ![IO.File]::Exists($comfyCancel)){[IO.File]::WriteAllText($comfyCancel,'cancel')}
    if([IO.File]::Exists($comfyStatus)){try{$c=Get-Content -LiteralPath $comfyStatus -Raw -Encoding UTF8|ConvertFrom-Json; $state.Status=$c.message; $state.Detail=$c.detail; if($null -ne $c.percent){$state.Percent=[double]$c.percent}}catch{}}
   }
   $comfyProcess.Dispose()
   if(![IO.File]::Exists($comfyResult)){ throw ('ComfyUI installation ended without a result. '+$comfyErr.GetAwaiter().GetResult()) }
   $comfyDone=Get-Content -LiteralPath $comfyResult -Raw -Encoding UTF8|ConvertFrom-Json
   if(!$comfyDone.success){ throw $comfyDone.detail }
   $comfyRoot=$comfyDone.root; $modelRoot=Join-Path $comfyRoot 'models\audio_separation'; $state.Percent=-1
  }
  if ($state.Cancel) { throw 'Setup cancelled.' }
  $download=[hashtable]::Synchronized(@{Running=$true;Cancel=[bool]$state.Cancel;Done=$false;Success=$false;Bytes=[long]0;Total=[long]0;Status='Checking existing models';Error=''})
  $state.Download=$download; $state.Phase='models'
  if ($state.Cancel) { $download.Cancel=$true }
  & $worker $download $packs $modelRoot $transferPath $null @($legacyRoot)
  if (!$download.Success) { throw $download.Error }
  if ($state.Cancel) { throw 'Setup cancelled. Verified files and new partial downloads are kept for retry.' }
  $state.Phase='services'; $state.Status='Preparing ComfyUI and API Proxy'; $state.Detail='Preparing the integration and private proxy runtime.'
  $statusFile=Join-Path $workDir 'services-status.json'
  $resultFile=Join-Path $workDir 'services-result.json'
  $cancelFile=Join-Path $workDir 'services-cancel'
  foreach($path in @($statusFile,$resultFile,$cancelFile)){ if([IO.File]::Exists($path)){[IO.File]::Delete($path)} }
  $config=@{comfyRoot=$comfyRoot;comfyUrl=$comfyUrl;userData=(Join-Path $env:APPDATA 'stem-studio');resources=(Join-Path $appDir 'resources');allowEngineRestart=[bool]$allowRestart;statusFile=$statusFile;resultFile=$resultFile;cancelFile=$cancelFile}
  $configFile=Join-Path $workDir 'services-config.json'
  [IO.File]::WriteAllText($configFile,($config|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=Join-Path $appDir 'Stem Studio.exe'
  $helper=Join-Path $appDir 'resources\setup\complete-setup.mjs'
  $start.Arguments='"'+$helper+'" "'+$configFile+'"'
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.WindowStyle='Hidden'
  $start.RedirectStandardError=$true; $start.RedirectStandardOutput=$true
  $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
  $start.EnvironmentVariables['STEM_QUIET_PROCESS']=Join-Path $appDir 'resources\setup\QuietProcess.exe'
  $process=[Diagnostics.Process]::Start($start)
  $stderrTask=$process.StandardError.ReadToEndAsync()
  $stdoutTask=$process.StandardOutput.ReadToEndAsync()
  while(!$process.WaitForExit(200)) {
   if($state.Cancel -and ![IO.File]::Exists($cancelFile)){[IO.File]::WriteAllText($cancelFile,'cancel')}
   if([IO.File]::Exists($statusFile)){try{$status=Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8|ConvertFrom-Json; $state.Status=$status.message; $state.Detail=$status.detail}catch{}}
  }
  $stderr=$stderrTask.GetAwaiter().GetResult()
  $stdout=$stdoutTask.GetAwaiter().GetResult()
  $logFolder=Join-Path $env:LOCALAPPDATA 'Stem Studio\setup-logs'
  [IO.Directory]::CreateDirectory($logFolder)|Out-Null
  $logFile=Join-Path $logFolder ('services-'+[guid]::NewGuid().ToString('N')+'.log')
  [IO.File]::WriteAllText($logFile,("Exit code: "+$process.ExitCode+"`r`n"+$stderr+"`r`n"+$stdout))
  if(![IO.File]::Exists($resultFile)){
   $tail=if($stderr.Length-gt 1800){$stderr.Substring($stderr.Length-1800)}else{$stderr}
   throw ("Service preparation exited without a result (exit "+$process.ExitCode+"). Models remain available. Log: "+$logFile+"`n"+$tail)
  }
  $result=Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8|ConvertFrom-Json
  if(!$result.success){throw $result.detail}
  $state.Success=$true; $state.Status=$result.message; $state.Detail=$result.detail
 } catch {$state.Error=$_.Exception.Message; $state.Status='Setup needs attention.'}
 finally {if($process){$process.Dispose()}; $state.Running=$false; $state.Done=$true}
}
