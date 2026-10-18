$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class StemSetupDpi {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 public static void Configure(){try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){SetProcessDPIAware();}}
}
'@
[StemSetupDpi]::Configure()
[AppContext]::SetSwitch('Switch.System.Windows.DoNotScaleForDpiChanges',$false)
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms
. (Join-Path $PSScriptRoot 'Unified-Worker.ps1')
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'models.json') -Raw|ConvertFrom-Json
$settings=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'version.json') -Raw|ConvertFrom-Json
$window=[Windows.Markup.XamlReader]::Load([Xml.XmlReader]::Create((Join-Path $PSScriptRoot 'Setup.xaml')))
$ui=@{}
foreach($name in @('TitleBar','Minimize','Close','Step0','Step1','Step2','Step3','Version','WelcomePage','DestinationPage','ModelsPage','ProgressPage','Destination','BrowseDestination','HaveComfy','InstallComfy','ExistingPanel','InstallPanel','InstallParent','BrowseInstall','GpuHint','ComfyFolder','BrowseComfy','ComfyHint','ComfyAddress','RestartEngine','ModelFolder','Sfc','Uss','Bandit','Mrx','Consent','LicenseText','ProgressTitle','ProgressCopy','Status','Progress','Details','Outcome','Error','Back','Next')){$ui[$name]=$window.FindName($name)}
$area=[Windows.SystemParameters]::WorkArea
$window.Width=[Math]::Min(980,$area.Width-24); $window.Height=[Math]::Min(740,$area.Height-24)
$window.MinWidth=[Math]::Min(740,$window.Width); $window.MinHeight=[Math]::Min(520,$window.Height)
$ui.Version.Text='VERSION '+$settings.version+' / PREVIEW'
$ui.Destination.Text=Join-Path $env:LOCALAPPDATA 'Programs\Stem Studio'
$previous=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\6cac86da-5765-5bbc-9e05-9132e4b92b52' -ErrorAction SilentlyContinue
if($previous.InstallLocation -and [IO.Directory]::Exists($previous.InstallLocation)){$ui.Destination.Text=$previous.InstallLocation}
$profile=$null
try{$profile=Get-Content -LiteralPath (Join-Path $env:APPDATA 'stem-studio\connection.json') -Raw|ConvertFrom-Json}catch{}
function Resolve-Comfy([string]$path){
 if(!$path){return $null}
 foreach($candidate in @($path,(Join-Path $path 'ComfyUI'))){if([IO.File]::Exists((Join-Path $candidate 'main.py'))){return [IO.Path]::GetFullPath($candidate)}}
 return $null
}
function Set-Comfy([string]$path){
 $resolved=Resolve-Comfy $path
 if(!$resolved){throw 'Select the ComfyUI folder containing main.py, or its portable parent.'}
 $ui.ComfyFolder.Text=$resolved; $ui.ModelFolder.Text=Join-Path $resolved 'models\audio_separation'
 $ui.ComfyHint.Text='Selected engine: '+$resolved
}
foreach($candidate in @($profile.installation,$env:COMFYUI_PATH,'C:\AI\ComfyUI\ComfyUI_windows_portable\ComfyUI',(Join-Path $env:USERPROFILE 'ComfyUI'),(Join-Path $env:USERPROFILE 'Documents\ComfyUI'))){if(Resolve-Comfy $candidate){Set-Comfy $candidate; $ui.ComfyHint.Text='Detected installation. Confirm this folder before continuing.';break}}
$script:comfyInstall=$false; $script:installParent=''; $script:gpuKind='nvidia'
try{$gpus=@(Get-CimInstance Win32_VideoController -ErrorAction Stop|ForEach-Object{$_.Name})}catch{$gpus=@()}
$gpuText=$gpus -join ' '
if($gpuText-match '(?i)nvidia|geforce|rtx|quadro'){$script:gpuKind='nvidia'}elseif($gpuText-match '(?i)radeon|amd'){$script:gpuKind='amd'}elseif($gpuText-match '(?i)intel'){$script:gpuKind='intel'}
$ui.InstallParent.Text=Join-Path $env:USERPROFILE 'ComfyUI'
$ui.GpuHint.Text=if($gpus.Count){'Detected graphics: '+($gpus -join ', ')+'. Setup downloads the '+$script:gpuKind.ToUpper()+' build.'}else{'No graphics adapter was detected. Setup downloads the NVIDIA build.'}
function Set-ComfyMode([string]$mode){
 $ui.HaveComfy.IsChecked=($mode-eq 'have'); $ui.InstallComfy.IsChecked=($mode-eq 'install')
 $ui.ExistingPanel.Visibility=if($mode-eq 'have'){'Visible'}else{'Collapsed'}; $ui.InstallPanel.Visibility=if($mode-eq 'install'){'Visible'}else{'Collapsed'}
 if($mode-eq 'install'){$ui.ModelFolder.Text=Join-Path $ui.InstallParent.Text 'ComfyUI_windows_portable\ComfyUI\models\audio_separation'}
}
if($ui.ComfyFolder.Text){Set-ComfyMode 'have'}
if($profile.comfyUrl){$ui.ComfyAddress.Text=$profile.comfyUrl}
$legacy=Join-Path $env:LOCALAPPDATA 'Stem Studio\models'
if([IO.File]::Exists((Join-Path $legacy 'uss\at_soft.ckpt'))){$ui.Uss.IsChecked=$true}
$ui.LicenseText.Text=($manifest.packs|ForEach-Object{"$($_.name)`n$($_.license)`n$($_.licenseUrl)`n$($_.source)"}) -join "`n`n"
$script:page=0; $script:stage='idle'; $script:process=$null; $script:job=$null; $script:runspace=$null; $script:async=$null; $script:launchRequested=$false; $script:installed=$false; $script:installFolder=''; $script:selected=@()
$state=[hashtable]::Synchronized(@{Running=$false;Cancel=$false;Done=$false;Success=$false;Phase='';Status='';Detail='';Error='';Download=$null;Percent=-1})
function Set-Page([int]$index){
 $script:page=$index; $pages=@('WelcomePage','DestinationPage','ModelsPage','ProgressPage')
 for($i=0;$i-lt 4;$i++){$ui[$pages[$i]].Visibility=if($i-eq $index){'Visible'}else{'Collapsed'}; $ui["Step$i"].Foreground=if($i-eq $index){'#F2FF59'}else{'#9B939F'}}
 $ui.Back.Visibility=if($index-eq 0-or $index-eq 3){'Collapsed'}else{'Visible'}
 $ui.Next.Content=@('Get started','Continue','Prepare everything','Close')[$index]; $ui.Error.Text=''
}
function Pick-Folder([string]$initial){$picker=New-Object Windows.Forms.FolderBrowserDialog; $picker.SelectedPath=$initial; try{if($picker.ShowDialog()-eq [Windows.Forms.DialogResult]::OK){return $picker.SelectedPath};return $null}finally{$picker.Dispose()}}
function Validate-Choices {
 if(!$ui.HaveComfy.IsChecked-and !$ui.InstallComfy.IsChecked){throw 'Tell setup whether you already have ComfyUI.'}
 if($ui.InstallComfy.IsChecked){
  $parent=$ui.InstallParent.Text.Trim()
  if(!$parent-or $parent.IndexOfAny([char[]]'"*?<>|')-ge 0-or $parent-notmatch '^[A-Za-z]:\\'-or $parent.Length-gt 100){throw 'Choose a local folder for ComfyUI on a drive, with a path shorter than 100 characters.'}
  $full=[IO.Path]::GetFullPath($parent).TrimEnd('\')
  $found=Resolve-Comfy (Join-Path $full 'ComfyUI_windows_portable')
  if($found){Set-Comfy $found;Set-ComfyMode 'have';$script:comfyInstall=$false}
  else{
   if((New-Object IO.DriveInfo($full.Substring(0,1))).AvailableFreeSpace-lt 12GB){throw 'ComfyUI needs about 12 GB of free disk space on that drive.'}
   $script:comfyInstall=$true;$script:installParent=$full
   $ui.ModelFolder.Text=Join-Path $full 'ComfyUI_windows_portable\ComfyUI\models\audio_separation'
  }
 } else {
  $root=Resolve-Comfy $ui.ComfyFolder.Text
  if(!$root){throw 'Choose your existing ComfyUI first. A valid main.py is required.'}
  Set-Comfy $root;$script:comfyInstall=$false
 }
 $address=[uri]$ui.ComfyAddress.Text.Trim()
 if($address.Scheme-ne 'http'-or $address.Host-notin @('127.0.0.1','localhost')-or $address.AbsolutePath-ne '/'-or $address.UserInfo-or $address.Query-or $address.Fragment){throw 'Unified setup requires a local HTTP ComfyUI address, such as http://127.0.0.1:8188.'}
 $value=$ui.Destination.Text.Trim()
 if(!$value-or $value.IndexOfAny([char[]]'"*?<>|')-ge 0-or $value-match '[\r\n]'-or $value-notmatch '^[A-Za-z]:\\'){throw 'Choose a local application folder.'}
 $script:installFolder=[IO.Path]::GetFullPath($value).TrimEnd('\')
 if($script:installFolder.Length-le 3-or $script:installFolder.Length-gt 180-or [IO.File]::Exists($script:installFolder)){throw 'Choose an application subfolder with a path shorter than 180 characters.'}
}
function Close-Worker {if($script:job){try{$script:job.EndInvoke($script:async)}catch{}finally{$script:job.Dispose();$script:runspace.Dispose();$script:job=$null}}}
function Start-Preparation {
 Close-Worker
 $state.Cancel=$false;$state.Done=$false;$state.Success=$false;$state.Error='';$state.Running=$true;$state.Download=$null;$state.Phase='starting';$state.Percent=-1
 $script:stage='preparing';$ui.Back.Visibility='Collapsed';$ui.Error.Text='';$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;$ui.Next.Content='Cancel preparation'
 $ui.ProgressTitle.Text='Preparing everything.';$ui.ProgressCopy.Text='Models, ComfyUI integration and private proxy in one flow. Existing valid files are reused.'
 $script:runspace=[RunspaceFactory]::CreateRunspace();$script:runspace.Open();$script:job=[PowerShell]::Create();$script:job.Runspace=$script:runspace
 $null=$script:job.AddScript($unifiedWorker.ToString()).AddArgument($state).AddArgument($script:selected).AddArgument($ui.ModelFolder.Text).AddArgument((Join-Path $PSScriptRoot 'Transfer.cs')).AddArgument($legacy).AddArgument($script:installFolder).AddArgument($ui.ComfyFolder.Text).AddArgument($ui.ComfyAddress.Text.TrimEnd('/')).AddArgument([bool]$ui.RestartEngine.IsChecked).AddArgument($PSScriptRoot).AddArgument($(if($script:comfyInstall){$script:installParent}else{''})).AddArgument($script:gpuKind)
 $script:async=$script:job.BeginInvoke()
}
function Finish-Preparation {
 Close-Worker;$script:stage='finished';$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;$ui.Next.Content='Finish';$ui.Progress.IsIndeterminate=$false
 if($state.Success){$ui.Progress.Value=100;$ui.ProgressTitle.Text='Everything is prepared.';$ui.ProgressCopy.Text='Click Finish to open Stem Studio. Your saved ComfyUI and proxy will connect automatically.';$ui.Status.Text=$state.Status;$ui.Details.Text=$ui.ModelFolder.Text;$ui.Outcome.Text=$state.Detail}
 else{$ui.Progress.Visibility='Collapsed';$ui.ProgressTitle.Text='Setup needs attention.';$ui.ProgressCopy.Text='The desktop app is installed. Verified files and resumable partials are kept.';$ui.Status.Text=$state.Status;$ui.Error.Text=$state.Error;$ui.Outcome.Text='Retry preparation to continue with the same selections. Completed verified models are not downloaded again.';$ui.Back.Content='Retry preparation';$ui.Back.Visibility='Visible'}
}
$ui.TitleBar.Add_MouseLeftButtonDown({try{$window.DragMove()}catch{}})
$ui.Minimize.Add_Click({$window.WindowState='Minimized'});$ui.Close.Add_Click({$window.Close()})
$window.Add_Closing({param($sender,$eventArgs)if($script:stage-eq 'installing'){$eventArgs.Cancel=$true};if($state.Running){$eventArgs.Cancel=$true;$state.Cancel=$true;if($state.Download){$state.Download.Cancel=$true};$ui.Next.IsEnabled=$false}})
$ui.BrowseComfy.Add_Click({try{$folder=Pick-Folder $ui.ComfyFolder.Text;if($folder){Set-Comfy $folder}}catch{$ui.Error.Text=$_.Exception.Message}})
$ui.HaveComfy.Add_Click({Set-ComfyMode 'have'});$ui.InstallComfy.Add_Click({Set-ComfyMode 'install'})
$ui.BrowseInstall.Add_Click({$folder=Pick-Folder $ui.InstallParent.Text;if($folder){$ui.InstallParent.Text=$folder;Set-ComfyMode 'install'}})
$ui.BrowseDestination.Add_Click({$folder=Pick-Folder $ui.Destination.Text;if($folder){$ui.Destination.Text=$folder}})
$ui.Back.Add_Click({if($script:stage-eq 'finished'){Start-Preparation}else{Set-Page ($script:page-1)}})
$ui.Next.Add_Click({
 try{
  $ui.Error.Text=''
  switch($script:page){
   0{Set-Page 1}
   1{Validate-Choices;Set-Page 2}
   2{
    Validate-Choices
    if(!$ui.Consent.IsChecked){throw 'Approve the displayed setup changes and model licenses to continue.'}
    $script:selected=@($manifest.packs|Where-Object{$_.id-eq 'sfc'-or ($_.id-eq 'uss'-and $ui.Uss.IsChecked)-or ($_.id-eq 'bandit'-and $ui.Bandit.IsChecked)-or ($_.id-eq 'mrx'-and $ui.Mrx.IsChecked)})
    if(@(Get-Process -Name 'Stem Studio' -ErrorAction SilentlyContinue).Count){throw 'Close Stem Studio before upgrading, then continue.'}
    Set-Page 3;$script:stage='installing';$ui.Close.IsEnabled=$false;$ui.Next.IsEnabled=$false;$ui.Progress.IsIndeterminate=$true;$ui.Status.Text='Installing application files';$ui.Details.Text='The installation engine does not report a reliable percentage.'
    $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $PSScriptRoot 'Core.exe';$start.Arguments='/S /currentuser /D='+$script:installFolder;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WindowStyle='Hidden';$script:process=[Diagnostics.Process]::Start($start)
   }
   3{if($script:stage-eq 'preparing'){$state.Cancel=$true;if($state.Download){$state.Download.Cancel=$true};$ui.Next.IsEnabled=$false}elseif($script:stage-eq 'failed'){$script:stage='idle';Set-Page 2}else{if($script:stage-eq 'finished'-and $state.Success){$script:launchRequested=$true};$window.Close()}}
  }
 }catch{$ui.Error.Text=$_.Exception.Message;if($script:stage-eq 'installing'){$script:stage='failed';$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;$ui.Next.Content='Try again';$ui.Progress.IsIndeterminate=$false}}
})
$timer=New-Object Windows.Threading.DispatcherTimer;$timer.Interval=[TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
 try{
  if($script:stage-eq 'installing'-and $script:process-and $script:process.HasExited){$code=$script:process.ExitCode;$script:process.Dispose();$script:process=$null;if($code-ne 0-or ![IO.File]::Exists((Join-Path $script:installFolder 'Stem Studio.exe'))){throw "Application installation failed (exit $code)."};$script:installed=$true;Start-Preparation}
  if($script:stage-eq 'preparing'){
   $ui.Progress.Visibility='Visible'
   if($state.Phase-eq 'models'-and $state.Download){$download=$state.Download;$ui.Progress.IsIndeterminate=$false;$ui.Progress.Value=if($download.Total){[Math]::Min(100,100*$download.Bytes/$download.Total)}else{0};$ui.Status.Text=$download.Status;$ui.Details.Text='{0:N1} / {1:N1} MiB | {2:N2} MiB/s' -f ($download.Bytes/1MB),($download.Total/1MB),($download.Rate/1MB)}
   elseif($state.Phase-eq 'comfy'){$ui.Progress.IsIndeterminate=($state.Percent-lt 0);if($state.Percent-ge 0){$ui.Progress.Value=$state.Percent};$ui.Status.Text=$state.Status;$ui.Details.Text=$state.Detail}
   else{$ui.Progress.IsIndeterminate=$true;$ui.Status.Text=$state.Status;$ui.Details.Text=$state.Detail}
   if($script:async.IsCompleted-and !$state.Done){$state.Running=$false;$state.Done=$true;$state.Error='Preparation stopped unexpectedly. Retry with the same selections.'}
   if($state.Done){Finish-Preparation}
  }
 }catch{$state.Running=$false;$state.Error=$_.Exception.Message;if($script:installed){Finish-Preparation}else{$script:stage='failed';$ui.Error.Text=$state.Error;$ui.Close.IsEnabled=$true;$ui.Next.IsEnabled=$true;$ui.Next.Content='Try again'}}
})
Set-Page 0;$timer.Start()
try{$null=$window.ShowDialog()}finally{$timer.Stop();Close-Worker}
if($script:launchRequested -and $state.Success){
 try {
  $launch=New-Object Diagnostics.ProcessStartInfo
  $launch.FileName=Join-Path $script:installFolder 'Stem Studio.exe'
  $launch.WorkingDirectory=$script:installFolder
  $launch.UseShellExecute=$false
  $launch.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $null=[Diagnostics.Process]::Start($launch)
 } catch { [Windows.MessageBox]::Show('Stem Studio is installed but could not open. Use the desktop shortcut. '+$_.Exception.Message,'Stem Studio')|Out-Null }
}
if($state.Success){exit 0}else{exit 2}
