$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StemSetupDpi {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 public static void Configure() {
  try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
  catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
 }
}
'@
[StemSetupDpi]::Configure()
[AppContext]::SetSwitch('Switch.System.Windows.DoNotScaleForDpiChanges', $false)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
. (Join-Path $PSScriptRoot 'Download-Worker.ps1')
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'models.json') -Raw | ConvertFrom-Json
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'version.json') -Raw | ConvertFrom-Json
$window = [Windows.Markup.XamlReader]::Load([Xml.XmlReader]::Create((Join-Path $PSScriptRoot 'Setup.xaml')))
$ui = @{}
foreach ($name in @('TitleBar','Minimize','Close','Step0','Step1','Step2','Step3','Version','WelcomePage','DestinationPage','ModelsPage','ProgressPage','Destination','BrowseDestination','BrowseModels','ModelFolder','Sfc','Uss','Consent','LicenseText','ProgressTitle','ProgressCopy','Status','Progress','Details','Outcome','Error','Back','Next')) { $ui[$name] = $window.FindName($name) }
$workArea = [Windows.SystemParameters]::WorkArea
$window.Width = [Math]::Min(980, $workArea.Width - 24)
$window.Height = [Math]::Min(700, $workArea.Height - 24)
$window.MinWidth = [Math]::Min(740, $window.Width)
$window.MinHeight = [Math]::Min(520, $window.Height)
$ui.Version.Text = 'VERSION ' + $settings.version + ' / PREVIEW'
$ui.Destination.Text = Join-Path $env:LOCALAPPDATA 'Programs\Stem Studio'
# Honor the previous installation directory when upgrading this per-user app.
$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\6cac86da-5765-5bbc-9e05-9132e4b92b52'
$previous = Get-ItemProperty -LiteralPath $uninstall -ErrorAction SilentlyContinue
if ($previous.InstallLocation -and [IO.Directory]::Exists($previous.InstallLocation)) { $ui.Destination.Text = $previous.InstallLocation }
$ui.ModelFolder.Text = Join-Path $env:LOCALAPPDATA 'Stem Studio\models'
$ui.LicenseText.Text = ($manifest.packs | ForEach-Object { "$($_.name)`n$($_.license)`n$($_.licenseUrl)`n$($_.source)" }) -join "`n`n"
$script:page=0; $script:stage='idle'; $script:process=$null; $script:job=$null; $script:runspace=$null; $script:async=$null; $script:installed=$false; $script:selected=@(); $script:installFolder=''
$state = [hashtable]::Synchronized(@{ Running=$false; Cancel=$false; Done=$false; Success=$false; Bytes=[long]0; Total=[long]0; Status=''; Error='' })
function Set-Page([int]$index) {
 $script:page=$index
 $pages=@('WelcomePage','DestinationPage','ModelsPage','ProgressPage')
 for ($i=0; $i -lt 4; $i++) {
  $ui[$pages[$i]].Visibility = if ($i -eq $index) { 'Visible' } else { 'Collapsed' }
  $ui["Step$i"].Foreground = if ($i -eq $index) { '#F2FF59' } else { '#9B939F' }
 }
 $ui.Back.Visibility = if ($index -eq 0 -or $index -eq 3) { 'Collapsed' } else { 'Visible' }
 $ui.Next.Content = @('Get started','Continue','Install workspace','Close')[$index]
 $ui.Error.Text=''
}
function Choose-Folder($control) {
 $picker=New-Object Windows.Forms.FolderBrowserDialog
 $picker.Description='Choose a folder for Stem Studio.'
 $picker.SelectedPath=$control.Text
 if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $control.Text=$picker.SelectedPath }
 $picker.Dispose()
}
function Test-Destination {
 $value=$ui.Destination.Text.Trim()
 if (!$value -or $value.IndexOfAny([char[]]'"*?<>|') -ge 0 -or $value -match '[\r\n]' -or $value -notmatch '^[A-Za-z]:\\') { throw 'Choose an absolute local Windows folder without special characters.' }
 $resolved=[IO.Path]::GetFullPath($value).TrimEnd('\')
 if ($resolved.Length -le 3 -or $resolved.Length -gt 180) { throw 'Choose an application subfolder with a path shorter than 180 characters.' }
 if ([IO.File]::Exists($resolved)) { throw 'The destination is a file. Choose a folder.' }
 $script:installFolder=$resolved
}
function Close-Worker {
 if ($script:job) { try { $script:job.EndInvoke($script:async) } catch { } finally { $script:job.Dispose(); $script:runspace.Dispose(); $script:job=$null } }
}
function Start-Models {
 Close-Worker
 $ui.Back.Visibility='Collapsed'; $ui.Error.Text=''
 $state.Cancel=$false; $state.Done=$false; $state.Success=$false; $state.Bytes=[long]0; $state.Error=''; $state.Running=$true
 $ui.Progress.IsIndeterminate=$false; $ui.Progress.Value=0; $ui.Progress.Visibility='Visible'
 $ui.ProgressTitle.Text='Preparing your toolkit.'; $ui.ProgressCopy.Text='Downloading your approved files. Interrupted files resume when the source supports it. Every completed file is verified.'
 $ui.Next.Content='Cancel download'; $ui.Next.IsEnabled=$true; $ui.Close.IsEnabled=$true; $script:stage='models'
 $script:runspace=[RunspaceFactory]::CreateRunspace(); $script:runspace.Open()
 $script:job=[PowerShell]::Create(); $script:job.Runspace=$script:runspace
 $null=$script:job.AddScript($worker.ToString()).AddArgument($state).AddArgument($script:selected).AddArgument($ui.ModelFolder.Text).AddArgument((Join-Path $PSScriptRoot 'Transfer.cs'))
 $script:async=$script:job.BeginInvoke()
}
function Finish-Setup([bool]$modelsComplete) {
 Close-Worker
 $script:stage='finished'; $ui.Progress.IsIndeterminate=$false; $ui.Progress.Value=100
 $ui.ProgressTitle.Text='Your workspace is ready.'
 $ui.ProgressCopy.Text='Stem Studio is installed. Open it from your desktop shortcut when you are ready.'
 $ui.Status.Text=if ($modelsComplete) { 'Application installed. Selected model files verified.' } else { 'Application installed.' }
 $ui.Details.Text=$script:installFolder
 $ui.Outcome.Text=if ($script:selected.Count -and !$modelsComplete) { 'Optional model preparation was skipped or incomplete. You can retry the download. Audio processing integration is pending.' } else { 'Start your ComfyUI, then use Set up & start proxy in the application connection settings. Audio processing integration is pending.' }
 $ui.Next.Content='Finish'; $ui.Next.IsEnabled=$true; $ui.Close.IsEnabled=$true
 if ($script:selected.Count -and !$modelsComplete) { $ui.Back.Content='Retry model download'; $ui.Back.Visibility='Visible' }
 if ($script:selected.Count -and !$modelsComplete) {
  $ui.ProgressTitle.Text='Models need attention.'
  $ui.ProgressCopy.Text='The application is installed, but your selected model files are not all ready.'
  $ui.Status.Text='Model preparation incomplete.'
  $ui.Progress.Visibility='Collapsed'
  $ui.Outcome.Text='Retry checks completed files and resumes saved partial data when supported. If a server ignores resume, that file restarts safely. Audio processing integration is pending.'
 }
}
$ui.TitleBar.Add_MouseLeftButtonDown({ param($sender,$eventArgs) if ($eventArgs.OriginalSource -isnot [Windows.Controls.Button]) { try { $window.DragMove() } catch { } } })
$ui.Minimize.Add_Click({ $window.WindowState='Minimized' })
$ui.Close.Add_Click({ $window.Close() })
$window.Add_KeyDown({ param($sender,$eventArgs) if ($eventArgs.Key -eq [Windows.Input.Key]::Escape) { $window.Close() } })
$window.Add_Closing({ param($sender,$eventArgs)
 if ($script:stage -eq 'installing') { $eventArgs.Cancel=$true; return }
 if ($state.Running) { $eventArgs.Cancel=$true; $state.Cancel=$true; $ui.Next.IsEnabled=$false; $ui.Status.Text='Cancelling model download...'; return }
})
$ui.BrowseDestination.Add_Click({ Choose-Folder $ui.Destination })
$ui.BrowseModels.Add_Click({ Choose-Folder $ui.ModelFolder })
$ui.Back.Add_Click({ if ($script:stage -eq 'finished') { Start-Models } else { Set-Page ($script:page-1) } })
$ui.Next.Add_Click({
 try {
  $ui.Error.Text=''
  switch ($script:page) {
   0 { Set-Page 1 }
   1 { Test-Destination; Set-Page 2 }
   2 {
    Test-Destination
    $script:selected=@($manifest.packs | Where-Object { ($_.id -eq 'sfc' -and $ui.Sfc.IsChecked) -or ($_.id -eq 'uss' -and $ui.Uss.IsChecked) })
    if ($script:selected.Count -and !$ui.Consent.IsChecked) { throw 'Approve the selected model licenses and downloads, or deselect both models to continue without downloading.' }
    if (@(Get-Process -Name 'Stem Studio' -ErrorAction SilentlyContinue).Count) { throw 'Close Stem Studio before installing this version, then try again.' }
    Set-Page 3; $script:stage='installing'
    $ui.Close.IsEnabled=$false; $ui.Next.IsEnabled=$false; $ui.Progress.IsIndeterminate=$true
    $ui.Details.Text='Installing application files. The installation engine does not report a reliable percentage.'
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $PSScriptRoot 'Core.exe'
    # NSIS requires /D to be the last argument, without quotes, including paths with spaces.
    $start.Arguments='/S /currentuser /D='+$script:installFolder
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.WindowStyle='Hidden'
    $script:process=[Diagnostics.Process]::Start($start)
   }
   3 {
    if ($script:stage -eq 'models') { $state.Cancel=$true; $ui.Next.IsEnabled=$false }
    elseif ($script:stage -eq 'failed') { $script:stage='idle'; Set-Page 2 }
    else { $window.Close() }
   }
  }
 } catch {
  $ui.Error.Text=$_.Exception.Message
  if ($script:stage -eq 'installing') { $script:stage='failed'; $ui.Close.IsEnabled=$true; $ui.Next.IsEnabled=$true; $ui.Next.Content='Try again'; $ui.Progress.IsIndeterminate=$false }
 }
})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
 try {
  if ($script:stage -eq 'installing' -and $script:process -and $script:process.HasExited) {
   $code=$script:process.ExitCode; $script:process.Dispose(); $script:process=$null
   if ($code -ne 0 -or ![IO.File]::Exists((Join-Path $script:installFolder 'Stem Studio.exe'))) { throw "The installation engine did not complete (exit code $code). Check folder permissions and try again." }
   $script:installed=$true
   if ($script:selected.Count) { Start-Models } else { Finish-Setup $false }
  }
  if ($script:stage -eq 'models') {
   $ui.Status.Text=$state.Status
   $ui.Progress.Value=if ($state.Total) { [Math]::Min(100,100*$state.Bytes/$state.Total) } else { 0 }
   $eta=if ($state.Eta -ge 0) { [TimeSpan]::FromSeconds([Math]::Min($state.Eta, 359999)).ToString('hh\:mm\:ss') } else { 'calculating' }
   $ui.Details.Text=if ($state.Status -like 'Downloading*') { '{0:N1} / {1:N1} MiB | {2:N2} MiB/s | ~{3} remaining' -f ($state.Bytes/1MB),($state.Total/1MB),($state.Rate/1MB),$eta } else { '{0:N1} / {1:N1} MiB | File verification is a separate step.' -f ($state.Bytes/1MB),($state.Total/1MB) }
   if ($script:async.IsCompleted -and !$state.Done) { $state.Error='The download worker stopped unexpectedly. Retry model preparation.'; $state.Running=$false; $state.Done=$true }
   if ($state.Done) { $ui.Error.Text=$state.Error; Finish-Setup ([bool]$state.Success) }
  }
 } catch {
  $ui.Error.Text=$_.Exception.Message
  $ui.Progress.IsIndeterminate=$false; $ui.Close.IsEnabled=$true; $ui.Next.IsEnabled=$true
  if ($script:installed) { $state.Running=$false; Finish-Setup $false } else { $script:stage='failed'; $ui.Next.Content='Try again' }
 }
})
Set-Page 0
$timer.Start()
try { $null=$window.ShowDialog() } finally { $timer.Stop(); Close-Worker }
if ($script:installed) { exit 0 } else { exit 2 }
