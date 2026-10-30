param(
    [switch]$Install,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$sendScript = Join-Path $PSScriptRoot 'clipkey-send.ps1'
$recvScript = Join-Path $PSScriptRoot 'clipkey-recv.ps1'
$logFile = Join-Path $env:TEMP 'clipkey-tray.log'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'ClipKey 보내기.lnk'
$SlowDelayMs = 20
if ($Uninstall) {
    Remove-Item $startupLink -ErrorAction SilentlyContinue
    Write-Host '자동 실행을 껐습니다. 떠 있는 아이콘은 오른쪽 클릭 > 끝내기로 닫으세요.' -ForegroundColor Green
    exit 0
}
if ($Install) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($startupLink)
    $link.TargetPath = (Get-Command powershell.exe).Source
    $link.Arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    $link.WorkingDirectory = $PSScriptRoot
    $link.WindowStyle = 7
    $link.Save()
    Start-Process $link.TargetPath -ArgumentList $link.Arguments -WindowStyle Hidden
    Write-Host '로그인할 때 자동으로 트레이에 뜨도록 등록했고, 지금도 띄웠습니다.' -ForegroundColor Green
    exit 0
}
$mutex = New-Object System.Threading.Mutex($false, 'ClipKeyTray')
if (-not $mutex.WaitOne(0)) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
Add-Type -Namespace ClipKeyTray -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
$LockKeys = @(
    @{ Name = 'NumLock'; Vk = 0x90; Scan = 0x45; Ext = 1 },
    @{ Name = 'CapsLock'; Vk = 0x14; Scan = 0x3A; Ext = 0 },
    @{ Name = 'Scroll'; Vk = 0x91; Scan = 0x46; Ext = 0 }
)
function Get-Locks {
    $state = @{}
    foreach ($key in $LockKeys) { $state[$key.Name] = [Windows.Forms.Control]::IsKeyLocked($key.Name) }
    return $state
}
function Restore-Locks($want) {
    foreach ($key in $LockKeys) {
        if ([Windows.Forms.Control]::IsKeyLocked($key.Name) -ne $want[$key.Name]) {
            [ClipKeyTray.Keys]::keybd_event($key.Vk, $key.Scan, $key.Ext, [UIntPtr]::Zero)
            [ClipKeyTray.Keys]::keybd_event($key.Vk, $key.Scan, $key.Ext -bor 2, [UIntPtr]::Zero)
        }
    }
}
function New-Icon([Drawing.Color]$color) {
    $bmp = New-Object Drawing.Bitmap 16, 16
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.FillEllipse((New-Object Drawing.SolidBrush $color), 0, 0, 15, 15)
    $font = New-Object Drawing.Font('Arial', 9, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $center = New-Object Drawing.StringFormat
    $center.Alignment = 'Center'
    $center.LineAlignment = 'Center'
    $g.DrawString('CK', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(0, 0, 16, 16)), $center)
    $g.Dispose()
    return [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$idleIcon = New-Icon ([Drawing.Color]::SteelBlue)
$busyIcon = New-Icon ([Drawing.Color]::DarkOrange)
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $idleIcon
$tray.Text = 'ClipKey 보내기 (두 번 클릭: 클립보드)'
$menu = New-Object Windows.Forms.ContextMenuStrip
$miClip = New-Object Windows.Forms.ToolStripMenuItem '클립보드 보내기'
$miClip.Font = New-Object Drawing.Font($miClip.Font, [Drawing.FontStyle]::Bold)
$miFile = New-Object Windows.Forms.ToolStripMenuItem '파일 보내기...'
$miParts = New-Object Windows.Forms.ToolStripMenuItem '빠진 조각 다시 보내기...'
$miStop = New-Object Windows.Forms.ToolStripMenuItem '보내기 멈추기'
$miStop.Enabled = $false
$miRecv = New-Object Windows.Forms.ToolStripMenuItem '받기 창'
$miSlow = New-Object Windows.Forms.ToolStripMenuItem ('천천히 보내기 (깨질 때, {0}ms)' -f $SlowDelayMs)
$miSlow.CheckOnClick = $true
$miLog = New-Object Windows.Forms.ToolStripMenuItem '마지막 기록 보기'
$miQuit = New-Object Windows.Forms.ToolStripMenuItem '끝내기'
[void]$menu.Items.AddRange(@($miClip, $miFile, $miParts, $miStop, (New-Object Windows.Forms.ToolStripSeparator), $miRecv, (New-Object Windows.Forms.ToolStripSeparator), $miSlow, $miLog, $miQuit))
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 300
$script:proc = $null
$script:stopped = $false
$script:lastArgs = $null
function Show-Note([string]$text, [string]$kind = 'Info') {
    if (-not $text) { $text = '(내용 없음)' }
    if ($text.Length -gt 250) { $text = $text.Substring(0, 250) }
    $tray.ShowBalloonTip(5000, 'ClipKey', $text, [Windows.Forms.ToolTipIcon]$kind)
}
function Set-Busy([bool]$busy) {
    $tray.Icon = if ($busy) { $busyIcon } else { $idleIcon }
    $tray.Text = if ($busy) { 'ClipKey: 보내는 중 (키보드를 쓰지 마세요)' } else { 'ClipKey 보내기 (두 번 클릭: 클립보드)' }
    $miClip.Enabled = -not $busy
    $miFile.Enabled = -not $busy
    $miParts.Enabled = -not $busy
    $miStop.Enabled = $busy
}
function Start-Send([string]$extraArgs) {
    if ($script:proc) { Show-Note '이미 보내는 중입니다.' 'Warning'; return }
    if (-not (Test-Path $sendScript)) { Show-Note "clipkey-send.ps1이 없습니다: $sendScript" 'Error'; return }
    if ($extraArgs -notmatch '-Parts') { $script:lastArgs = $extraArgs }
    if ($miSlow.Checked) { $extraArgs += " -DelayMs $SlowDelayMs" }
    $command = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8; `$ProgressPreference = 'SilentlyContinue'; " +
        "try {{ & '{0}'{1} *>&1 | ForEach-Object {{ `"`$_`" }}; exit `$LASTEXITCODE }} " +
        "catch {{ `"오류: `$(`$_.Exception.Message)`"; exit 1 }}") -f $sendScript.Replace("'", "''"), $extraArgs
    $info = New-Object Diagnostics.ProcessStartInfo 'powershell.exe'
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $script:locks = Get-Locks
    $script:stopped = $false
    $script:proc = [Diagnostics.Process]::Start($info)
    $script:outTask = $script:proc.StandardOutput.ReadToEndAsync()
    Set-Busy $true
    $timer.Start()
    Show-Note '보내는 중입니다. 끝나면 알려 드립니다. 그동안 키보드를 쓰지 마세요.'
}
function Complete-Send {
    $timer.Stop()
    $code = $script:proc.ExitCode
    $out = @($script:outTask.Result -split "`r?`n" | Where-Object { $_.Trim() })
    $script:proc.Dispose()
    $script:proc = $null
    Set-Content -Path $logFile -Encoding UTF8 -Value (@("[$(Get-Date)] 종료 코드 $code") + $out)
    Set-Busy $false
    if ($script:stopped) {
        Start-Sleep -Milliseconds 200
        Restore-Locks $script:locks
        Show-Note '보내기를 멈췄습니다. 기기는 2초 뒤 받던 내용을 버립니다.' 'Warning'
    } elseif ($code -eq 0 -and $out.Count) {
        Show-Note $out[-1]
    } elseif ($out.Count) {
        Show-Note ($out[([math]::Max(0, $out.Count - 2))..($out.Count - 1)] -join ' ') 'Error'
    } else {
        Show-Note "보내지 못했습니다 (종료 코드 $code)." 'Error'
    }
}
$timer.Add_Tick({ if ($script:proc -and $script:proc.HasExited) { Complete-Send } })
$miClip.Add_Click({ Start-Send '' })
$tray.Add_MouseDoubleClick({ param($s, $e) if ($e.Button -eq 'Left') { Start-Send '' } })
$miFile.Add_Click({
    $dialog = New-Object Windows.Forms.OpenFileDialog
    $dialog.Title = 'ClipKey로 보낼 파일 (크면 조각으로 나눠 보냄, 32KB에 약 13분)'
    if ($dialog.ShowDialog() -eq 'OK') { Start-Send (" -Path '{0}'" -f $dialog.FileName.Replace("'", "''")) }
})
$miParts.Add_Click({
    if ($null -eq $script:lastArgs) { Show-Note '먼저 보낸 것이 없습니다.' 'Warning'; return }
    $what = if ($script:lastArgs) { '마지막에 보낸 파일' } else { '클립보드(보낼 때와 내용이 같아야 함)' }
    $numbers = [Microsoft.VisualBasic.Interaction]::InputBox("$what 에서 다시 보낼 조각 번호 (예: 3,5)", 'ClipKey 조각 다시 보내기', '')
    if ($numbers -match '^[\d,\s]+$') { Start-Send ("{0} -Parts '{1}'" -f $script:lastArgs, $numbers.Trim()) }
    elseif ($numbers) { Show-Note '숫자와 쉼표만 넣으세요. 예: 3,5' 'Warning' }
})
$miStop.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) {
        $script:stopped = $true
        $script:proc.Kill()
    }
})
$miRecv.Add_Click({
    if (-not (Test-Path $recvScript)) { Show-Note "clipkey-recv.ps1이 없습니다: $recvScript" 'Error'; return }
    $info = New-Object Diagnostics.ProcessStartInfo 'powershell.exe'
    $info.Arguments = '-STA -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $recvScript
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    [void][Diagnostics.Process]::Start($info)
})
$miLog.Add_Click({
    if (Test-Path $logFile) { Start-Process notepad.exe $logFile } else { Show-Note '아직 기록이 없습니다.' }
})
$miQuit.Add_Click({
    if ($script:proc -and -not $script:proc.HasExited) {
        $script:stopped = $true
        $script:proc.Kill()
        $script:proc.WaitForExit()
        Complete-Send
    }
    $tray.Visible = $false
    [Windows.Forms.Application]::Exit()
})
try {
    [Windows.Forms.Application]::Run()
}
finally {
    $tray.Dispose()
    $mutex.ReleaseMutex()
}
