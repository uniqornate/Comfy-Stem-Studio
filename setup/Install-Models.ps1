param([string]$PackIds = 'sfc,uss')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'models.json') -Raw | ConvertFrom-Json
$ids = @($PackIds.Split(',') | Where-Object { $_ })
if (@($ids | Where-Object { $_ -notin @('sfc','uss','bandit','mrx') }).Count) { throw 'Unknown model pack.' }
$packs = @($manifest.packs | Where-Object { $_.id -in $ids })
if (!$packs.Count) { exit 2 }
$state = [hashtable]::Synchronized(@{ Running=$false; Cancel=$false; Done=$false; Success=$false; Bytes=[long]0; Total=[long]0; Status='Waiting for your consent.'; Error='' })
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Stem Studio | Model setup" Width="720" Height="660" MinWidth="640" MinHeight="600" WindowStartupLocation="CenterScreen" Background="#211927" Foreground="#F0EFED" FontFamily="Segoe UI">
 <Window.Resources>
  <Style TargetType="Button"><Setter Property="Background" Value="#F2FF59"/><Setter Property="Foreground" Value="#211927"/><Setter Property="Padding" Value="18,10"/><Setter Property="Margin" Value="0,0,10,0"/><Setter Property="FontWeight" Value="SemiBold"/></Style>
  <Style TargetType="TextBlock"><Setter Property="TextWrapping" Value="Wrap"/></Style>
 </Window.Resources>
 <ScrollViewer VerticalScrollBarVisibility="Auto"><StackPanel Margin="32">
  <TextBlock Text="STEM STUDIO / MODEL SETUP" Foreground="#F2FF59" FontWeight="Bold"/>
  <TextBlock Text="Prepare your sound toolkit." FontSize="29" FontWeight="SemiBold" Margin="0,18,0,12"/>
  <TextBlock Text="Download only with your approval. This recovery helper downloads model files only. Use the main installer to prepare the full ComfyUI integration and proxy." Foreground="#C2BFB9"/>
  <Border Background="#2A2330" CornerRadius="12" Padding="18" Margin="0,20,0,16"><StackPanel>
   <TextBlock Name="Packs" Foreground="#F0EFED"/>
   <TextBlock Name="Licenses" Foreground="#C2BFB9" Margin="0,12,0,0"/>
  </StackPanel></Border>
  <TextBlock Text="MODEL FOLDER" FontSize="11" Foreground="#C2BFB9"/>
  <DockPanel Margin="0,8,0,14"><Button Name="Browse" Content="Browse" DockPanel.Dock="Right" Margin="10,0,0,0"/><TextBox Name="Folder" IsReadOnly="True" Background="#2A2330" Foreground="#F0EFED" BorderBrush="#504755" Padding="8" VerticalContentAlignment="Center"/></DockPanel>
  <CheckBox Name="Consent" Foreground="#F0EFED" Margin="0,0,0,18"><TextBlock Text="I accept the listed model licenses and approve downloading the selected files. SFC weights are restricted to non-commercial use."/></CheckBox>
  <ProgressBar Name="Progress" Height="7" Minimum="0" Maximum="100" Foreground="#F2FF59" Background="#2A2330"/>
  <TextBlock Name="Status" Text="Waiting for your consent." Margin="0,12,0,6"/>
  <TextBlock Name="Details" Foreground="#C2BFB9" FontSize="12"/>
  <StackPanel Orientation="Horizontal" Margin="0,22,0,0"><Button Name="Download" Content="Approve &amp; download" IsEnabled="False"/><Button Name="Cancel" Content="Skip for now" Background="#39313F" Foreground="#F0EFED"/></StackPanel>
 </StackPanel></ScrollViewer>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($name in @('Packs','Licenses','Browse','Folder','Consent','Progress','Status','Details','Download','Cancel')) { $ui[$name] = $window.FindName($name) }
$ui.Folder.Text = Join-Path $env:LOCALAPPDATA 'Stem Studio\models'
$ui.Packs.Text = ($packs | ForEach-Object { '{0}  |  {1:N1} MiB' -f $_.name, (($_.files | Measure-Object size -Sum).Sum / 1MB) }) -join "`n"
$ui.Licenses.Text = ($packs | ForEach-Object { "$($_.license)`n$($_.licenseUrl)`nSource: $($_.source)" }) -join "`n`n"
$ui.Consent.Add_Click({ $ui.Download.IsEnabled = [bool]$ui.Consent.IsChecked -and !$state.Running })
$ui.Browse.Add_Click({
 $picker = New-Object Windows.Forms.FolderBrowserDialog
 $picker.Description = 'Choose where Stem Studio should keep verified model files.'
 if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $ui.Folder.Text = $picker.SelectedPath }
 $picker.Dispose()
})
. (Join-Path $PSScriptRoot 'Download-Worker.ps1')
$script:job = $null; $script:runspace = $null; $script:async = $null
$ui.Download.Add_Click({
 if (!$ui.Consent.IsChecked -or $state.Running) { return }
 if ($script:job) { $script:job.EndInvoke($script:async); $script:job.Dispose(); $script:runspace.Dispose() }
 $state.Cancel=$false; $state.Done=$false; $state.Success=$false; $state.Error=''; $state.Bytes=[long]0; $state.Running=$true
 $ui.Download.IsEnabled=$false; $ui.Browse.IsEnabled=$false; $ui.Consent.IsEnabled=$false; $ui.Cancel.Content='Cancel download'
 $script:runspace = [RunspaceFactory]::CreateRunspace(); $script:runspace.Open()
 $script:job = [PowerShell]::Create(); $script:job.Runspace=$script:runspace
 $null = $script:job.AddScript($worker.ToString()).AddArgument($state).AddArgument($packs).AddArgument($ui.Folder.Text).AddArgument((Join-Path $PSScriptRoot 'Transfer.cs'))
 $script:async = $script:job.BeginInvoke()
})
$ui.Cancel.Add_Click({ if ($state.Running) { $state.Cancel=$true; $ui.Cancel.IsEnabled=$false } else { $window.Close() } })
$window.Add_Closing({ param($sender,$eventArgs) if ($state.Running) { $eventArgs.Cancel=$true; $state.Cancel=$true; $ui.Cancel.IsEnabled=$false } })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
 $ui.Status.Text=$state.Status
 $ui.Progress.Value= if ($state.Total) { [Math]::Min(100, 100*$state.Bytes/$state.Total) } else { 0 }
 $ui.Details.Text= if ($state.Error) { $state.Error } elseif ($state.Status -like 'Downloading*') { '{0:N1} / {1:N1} MiB | {2:N2} MiB/s' -f ($state.Bytes/1MB), ($state.Total/1MB), ($state.Rate/1MB) } else { '{0:N1} / {1:N1} MiB | Checksums verified before finalizing files.' -f ($state.Bytes/1MB), ($state.Total/1MB) }
 if ($state.Done) {
  $ui.Cancel.IsEnabled=$true; $ui.Cancel.Content='Close'
  $ui.Browse.IsEnabled=!$state.Success; $ui.Consent.IsEnabled=!$state.Success
  $ui.Download.IsEnabled=!$state.Success -and [bool]$ui.Consent.IsChecked; $ui.Download.Content='Retry download'
 }
})
$timer.Start()
$null=$window.ShowDialog()
$timer.Stop()
if ($script:job) { $script:job.EndInvoke($script:async); $script:job.Dispose(); $script:runspace.Dispose() }
if ($state.Success) { exit 0 } else { exit 2 }

