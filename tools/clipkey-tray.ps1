param(
    [switch]$Install,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ClipKeyVersion = '1.0.98'
$sendScript = Join-Path $PSScriptRoot 'clipkey-send.ps1'
$recvScript = Join-Path $PSScriptRoot 'clipkey-recv.ps1'
$logFile = Join-Path $env:TEMP 'clipkey-tray.log'
$resumeFile = Join-Path $env:TEMP 'clipkey-tray-resume.json'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'ClipKey 보내기.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClipKey 트레이.lnk'
$SlowDelayMs = 20
if ($Uninstall) {
    Remove-Item $startupLink, $desktopLink -ErrorAction SilentlyContinue
    Write-Host '자동 실행을 껐습니다. 떠 있는 아이콘은 오른쪽 클릭 > 끝내기로 닫으세요.' -ForegroundColor Green
    exit 0
}
function New-TrayLink([string]$path) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = (Get-Command powershell.exe).Source
    $link.Arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
    $link.WorkingDirectory = $PSScriptRoot
    $link.WindowStyle = 7
    $link.IconLocation = "$env:SystemRoot\System32\input.dll,1"
    $link.Save()
    $link
}
if ($Install) {
    $link = New-TrayLink $startupLink
    [void](New-TrayLink $desktopLink)
    Start-Process $link.TargetPath -ArgumentList $link.Arguments -WindowStyle Hidden
    Write-Host '로그인할 때 자동으로 트레이에 뜨도록 등록했고, 지금도 띄웠습니다.' -ForegroundColor Green
    Write-Host "바탕 화면의 'ClipKey 트레이' 아이콘을 작업 표시줄로 끌어다 놓으면, 트레이가 꺼졌을 때 눌러서 다시 띄울 수 있습니다." -ForegroundColor Green
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
$idleTip = "ClipKey 보내기 $ClipKeyVersion (두 번 클릭: 클립보드)"
$tray.Text = $idleTip
$menu = New-Object Windows.Forms.ContextMenuStrip
$miClip = New-Object Windows.Forms.ToolStripMenuItem '클립보드 보내기'
$miClip.Font = New-Object Drawing.Font($miClip.Font, [Drawing.FontStyle]::Bold)
$miFile = New-Object Windows.Forms.ToolStripMenuItem '파일 보내기...'
$miResume = New-Object Windows.Forms.ToolStripMenuItem '이어 보내기'
$miParts = New-Object Windows.Forms.ToolStripMenuItem '빠진 조각 다시 보내기...'
$miStop = New-Object Windows.Forms.ToolStripMenuItem '보내기 멈추기'
$miStop.Enabled = $false
$miRecv = New-Object Windows.Forms.ToolStripMenuItem '받기 창'
$miSlow = New-Object Windows.Forms.ToolStripMenuItem ('천천히 보내기 (깨질 때, {0}ms)' -f $SlowDelayMs)
$miSlow.CheckOnClick = $true
$miLog = New-Object Windows.Forms.ToolStripMenuItem '마지막 기록 보기'
$miQuit = New-Object Windows.Forms.ToolStripMenuItem '끝내기'
$miVersion = New-Object Windows.Forms.ToolStripMenuItem "버전 $ClipKeyVersion"
$miVersion.Enabled = $false
[void]$menu.Items.AddRange(@($miClip, $miFile, $miResume, $miParts, $miStop, (New-Object Windows.Forms.ToolStripSeparator), $miRecv, (New-Object Windows.Forms.ToolStripSeparator), $miSlow, $miLog, $miQuit, $miVersion))
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 300
$script:proc = $null
$script:stopped = $false
$script:lastArgs = $null
$script:resumeList = @()
$ResumeMax = 5
$ResumeKeepDays = 7
try {
    $saved = Get-Content -Raw -Encoding UTF8 $resumeFile | ConvertFrom-Json
    if ($saved.last -is [string]) { $script:lastArgs = $saved.last }
    elseif ($saved.args -is [string]) { $script:lastArgs = $saved.args }
    $script:resumeList = @($saved.list | Where-Object {
            $_.id -is [string] -and $_.args -is [string] -and ((Get-Date) - [datetime]$_.at).TotalDays -lt $ResumeKeepDays
        } | Select-Object -First $ResumeMax)
} catch { }
function Save-Resume {
    $data = @{ last = $script:lastArgs; list = @($script:resumeList) }
    try { ConvertTo-Json -InputObject $data -Depth 4 | Set-Content -Encoding UTF8 $resumeFile } catch { }
}
function Remove-Resume([string]$id) {
    $script:resumeList = @($script:resumeList | Where-Object { $_.id -ne $id })
    Save-Resume
}
function Add-Resume($entry) {
    $script:resumeList = @(@($entry) + @($script:resumeList | Where-Object { $_.id -ne $entry.id }) | Select-Object -First $ResumeMax)
    Save-Resume
}
$stopSignal = New-Object Threading.EventWaitHandle($false, 'ManualReset', 'ClipKeySendStop')
$script:killAt = $null
function Show-Note([string]$text, [string]$kind = 'Info') {
    if (-not $text) { $text = '(내용 없음)' }
    if ($text.Length -gt 250) { $text = $text.Substring(0, 250) }
    $tray.ShowBalloonTip(5000, 'ClipKey', $text, [Windows.Forms.ToolTipIcon]$kind)
}
function Set-Busy([bool]$busy) {
    $tray.Icon = if ($busy) { $busyIcon } else { $idleIcon }
    $tray.Text = if ($busy) { 'ClipKey: 보내는 중 (키보드를 쓰지 마세요)' } else { $idleTip }
    $miClip.Enabled = -not $busy
    $miFile.Enabled = -not $busy
    $miParts.Enabled = -not $busy
    $miResume.Enabled = -not $busy
    $miStop.Enabled = $busy
}
function Start-Send([string]$what, [string]$more = '', [switch]$Cancel, [string]$parts = '') {
    if ($script:proc) { Show-Note '이미 보내는 중입니다.' 'Warning'; return $false }
    if (-not (Test-Path $sendScript)) { Show-Note "clipkey-send.ps1이 없습니다: $sendScript" 'Error'; return $false }
    $script:sendWhat = $what
    $script:sendParts = $parts
    $script:sendCancel = [bool]$Cancel
    if (-not $Cancel) { $script:lastArgs = $what; Save-Resume }
    $extraArgs = "$what$more"
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
    $script:killed = $false
    $script:killAt = $null
    [void]$stopSignal.Reset()
    $script:proc = [Diagnostics.Process]::Start($info)
    $script:outTask = $script:proc.StandardOutput.ReadToEndAsync()
    Set-Busy $true
    $timer.Start()
    if (-not $Cancel) { Show-Note '보내는 중입니다. 끝나면 알려 드립니다. 그동안 키보드를 쓰지 마세요.' }
    $true
}
function Expand-Parts([string]$text) {
    $list = New-Object System.Collections.Generic.List[int]
    foreach ($item in ($text -split '[,\s]+' | Where-Object { $_ })) {
        if ($item -match '^(\d{1,5})-(\d{1,5})$') { foreach ($n in [int]$Matches[1]..[int]$Matches[2]) { $list.Add($n) } }
        elseif ($item -match '^\d{1,5}$') { $list.Add([int]$item) }
    }
    , [int[]]@($list | Sort-Object -Unique)
}
function Join-Parts([int[]]$numbers) {
    $runs = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $numbers.Count) {
        $j = $i
        while ($j + 1 -lt $numbers.Count -and $numbers[$j + 1] -eq $numbers[$j] + 1) { $j++ }
        $runs.Add($(if ($j -eq $i) { "$($numbers[$i])" } elseif ($j -eq $i + 1) { "$($numbers[$i]),$($numbers[$j])" } else { "$($numbers[$i])-$($numbers[$j])" }))
        $i = $j + 1
    }
    $runs -join ','
}
function Update-Resume($out, [int]$code) {
    $head = $out | Where-Object { $_ -match '^묶음 ([0-9a-f]{8}) 조각 (\d+)개: (.*)$' } | Select-Object -First 1
    if (-not ($head -and $head -match '^묶음 ([0-9a-f]{8}) 조각 (\d+)개: (.*)$')) { return $null }
    $id, $count, $name = $Matches[1], [int]$Matches[2], $Matches[3]
    $left = $out | Where-Object { $_ -match '-Parts ([\d,\-]+)' } | Select-Object -Last 1
    $notSent = if ($left -and $left -match '-Parts ([\d,\-]+)') { Expand-Parts $Matches[1] } else { [int[]]@() }
    if (-not $notSent.Count -and ($code -ne 0 -or $script:stopped)) { return $null }
    $old = $script:resumeList | Where-Object { $_.id -eq $id } | Select-Object -First 1
    $before = if ($old) { Expand-Parts $old.parts } else { [int[]]@() }
    $picked = if ($script:sendParts) { Expand-Parts $script:sendParts } else { [int[]](1..$count) }
    $remain = [int[]]@(@($before | Where-Object { $picked -notcontains $_ }) + @($notSent) | Sort-Object -Unique)
    if (-not $remain.Count) { Remove-Resume $id; return $null }
    $entry = [pscustomobject]@{ args = $script:sendWhat; name = $name; id = $id; count = $count; parts = (Join-Parts $remain); at = (Get-Date).ToString('o') }
    Add-Resume $entry
    if ($notSent.Count) { return $entry }
    $null
}
$script:keepForm = $null
$script:keepEntry = $null
$script:keepLeft = 0
$keepTimer = New-Object Windows.Forms.Timer
$keepTimer.Interval = 1000
function Close-KeepChoice([bool]$discard) {
    $keepTimer.Stop()
    $entry = $script:keepEntry
    $form = $script:keepForm
    $script:keepEntry = $null
    $script:keepForm = $null
    if ($form) { $form.Close(); $form.Dispose() }
    if (-not $entry) { return }
    if (-not $discard) { Show-Note ("보관했습니다: {0}. 트레이의 '이어 보내기'로 이어 보내세요." -f $entry.name); return }
    Remove-Resume $entry.id
    if (Start-Send (" -CancelId {0} -CancelCount {1}" -f $entry.id, $entry.count) -Cancel) {
        Show-Note ("폐기했습니다: {0}. 폰에도 지우라는 신호를 보냅니다." -f $entry.name)
    } else {
        Show-Note ("폐기했습니다: {0}. 폰의 '중단된 받기'에서는 직접 지우세요." -f $entry.name) 'Warning'
    }
}
$keepTimer.Add_Tick({
    $script:keepLeft--
    if ($script:keepLeft -le 0) { Close-KeepChoice $false }
    elseif ($script:keepForm) { $script:keepForm.AcceptButton.Text = "보관 ($($script:keepLeft))" }
})
function Show-KeepChoice($entry) {
    if ($script:keepForm) { Close-KeepChoice $false }
    $form = New-Object Windows.Forms.Form
    $form.Text = 'ClipKey 보내기 멈춤'
    $form.TopMost = $true
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $false
    $form.StartPosition = 'CenterScreen'
    $form.AutoSize = $true
    $form.AutoSizeMode = 'GrowAndShrink'
    $form.Padding = New-Object Windows.Forms.Padding(12)
    $layout = New-Object Windows.Forms.FlowLayoutPanel
    $layout.FlowDirection = 'TopDown'
    $layout.AutoSize = $true
    $label = New-Object Windows.Forms.Label
    $label.AutoSize = $true
    $label.MaximumSize = New-Object Drawing.Size(420, 0)
    $label.Text = "{0}`r`n남은 조각 {1} (전체 {2}개)`r`n`r`n보관하면 트레이의 '이어 보내기'로 남은 조각만 보낼 수 있습니다.`r`n폐기하면 폰의 '중단된 받기'에서도 지웁니다." -f $entry.name, $entry.parts, $entry.count
    $buttons = New-Object Windows.Forms.FlowLayoutPanel
    $buttons.AutoSize = $true
    $keep = New-Object Windows.Forms.Button
    $keep.AutoSize = $true
    $keep.Text = '보관 (5)'
    $keep.Add_Click({ Close-KeepChoice $false })
    $drop = New-Object Windows.Forms.Button
    $drop.AutoSize = $true
    $drop.Text = '폐기'
    $drop.Add_Click({ Close-KeepChoice $true })
    $buttons.Controls.AddRange(@($keep, $drop))
    $layout.Controls.AddRange(@($label, $buttons))
    $form.Controls.Add($layout)
    $form.AcceptButton = $keep
    $form.Add_FormClosing({ param($sender, $e) if ($script:keepForm -eq $sender) { $script:keepForm = $null; Close-KeepChoice $false } })
    $script:keepForm = $form
    $script:keepEntry = $entry
    $script:keepLeft = 5
    $form.Show()
    $form.Activate()
    $keepTimer.Start()
}
function Complete-Send {
    $timer.Stop()
    [void]$stopSignal.Reset()
    $code = $script:proc.ExitCode
    $out = @($script:outTask.Result -split "`r?`n" | Where-Object { $_.Trim() })
    $script:proc.Dispose()
    $script:proc = $null
    Set-Content -Path $logFile -Encoding UTF8 -Value (@("[$(Get-Date)] 트레이 $ClipKeyVersion, 종료 코드 $code") + $out)
    $entry = if ($script:sendCancel) { $null } else { Update-Resume $out $code }
    Set-Busy $false
    if ($script:stopped) {
        if ($script:killed) {
            Start-Sleep -Milliseconds 200
            Restore-Locks $script:locks
        }
        if ($entry -and -not $script:quitting) { Show-KeepChoice $entry }
        elseif ($script:sendCancel) { Show-Note "폐기 신호를 멈췄습니다. 폰의 '중단된 받기'에서는 직접 지우세요." 'Warning' }
        else { Show-Note '보내기를 멈추고 잠금 키를 되돌렸습니다.' 'Warning' }
    } elseif ($script:sendCancel -and $code -ne 0) {
        Show-Note "폐기 신호를 보내지 못했습니다. 폰의 '중단된 받기'에서는 직접 지우세요." 'Warning'
    } elseif ($code -eq 0 -and $out.Count) {
        Show-Note $out[-1]
    } elseif ($out.Count) {
        Show-Note ($out[([math]::Max(0, $out.Count - 2))..($out.Count - 1)] -join ' ') 'Error'
    } else {
        Show-Note "보내지 못했습니다 (종료 코드 $code)." 'Error'
    }
}
function Stop-Send([int]$graceSeconds) {
    if (-not $script:proc -or $script:proc.HasExited) { return }
    $script:stopped = $true
    [void]$stopSignal.Set()
    $script:killAt = (Get-Date).AddSeconds($graceSeconds)
    $miStop.Enabled = $false
    Show-Note '멈추는 중입니다. 잠금 키를 원래대로 되돌린 뒤 끝납니다.'
}
function Kill-Send {
    if ($script:proc -and -not $script:proc.HasExited) {
        $script:killed = $true
        $script:proc.Kill()
        $script:proc.WaitForExit()
    }
}
$timer.Add_Tick({
    if (-not $script:proc) { return }
    if ($script:proc.HasExited) { Complete-Send; return }
    if ($script:killAt -and (Get-Date) -gt $script:killAt) { Kill-Send; Complete-Send }
})
$miClip.Add_Click({ [void](Start-Send '') })
$tray.Add_MouseDoubleClick({ param($s, $e) if ($e.Button -eq 'Left') { [void](Start-Send '') } })
$miFile.Add_Click({
    $dialog = New-Object Windows.Forms.OpenFileDialog
    $dialog.Title = 'ClipKey로 보낼 파일 (크면 조각으로 나눠 보냄, 32KB에 약 13분)'
    if ($dialog.ShowDialog() -eq 'OK') { [void](Start-Send (" -Path '{0}'" -f $dialog.FileName.Replace("'", "''"))) }
})
function Send-Parts([string]$what, [string]$label, [string]$prefill, [string]$title) {
    $prompt = "$label 에서 보낼 조각 번호 (예: 3,5,8-40).`r`n폰 앱 받기 탭에 다른 번호가 보이면 그 번호로 바꾸세요."
    $numbers = [Microsoft.VisualBasic.Interaction]::InputBox($prompt, $title, $prefill)
    if ($numbers -match '^[\d,\-\s]+$' -and $numbers -match '\d') { [void](Start-Send $what (" -Parts '{0}'" -f $numbers.Trim()) -parts $numbers.Trim()) }
    elseif ($numbers) { Show-Note '숫자, 쉼표, -만 넣으세요. 예: 3,5,8-40' 'Warning' }
}
$miParts.Add_Click({
    if ($null -eq $script:lastArgs) { Show-Note '먼저 보낸 것이 없습니다.' 'Warning'; return }
    $label = if ($script:lastArgs) { '마지막에 보낸 파일' } else { '클립보드(보낼 때와 내용이 같아야 함)' }
    Send-Parts $script:lastArgs $label '' 'ClipKey 빠진 조각 다시 보내기'
})
function New-MenuItem([string]$text, $entry, [scriptblock]$onClick) {
    $item = New-Object Windows.Forms.ToolStripMenuItem $text
    $item.Tag = $entry
    if ($onClick) { $item.Add_Click($onClick) }
    $item
}
function Update-ResumeMenu {
    $miResume.DropDownItems.Clear()
    if (-not $script:resumeList.Count) {
        $none = New-MenuItem '(멈춘 보내기 없음)' $null $null
        $none.Enabled = $false
        [void]$miResume.DropDownItems.Add($none)
        return
    }
    foreach ($entry in $script:resumeList) {
        $when = ([datetime]$entry.at).ToString('M/d HH:mm')
        $item = New-MenuItem ("{0} · 남은 {1} / {2}개 · {3}" -f $entry.name, $entry.parts, $entry.count, $when) $entry $null
        [void]$item.DropDownItems.Add((New-MenuItem '남은 조각 보내기...' $entry {
                    param($sender)
                    $e = $sender.Tag
                    $label = if ($e.args) { $e.name } else { "$($e.name) (클립보드가 그때와 같아야 함)" }
                    Send-Parts $e.args $label $e.parts 'ClipKey 이어 보내기'
                }))
        [void]$item.DropDownItems.Add((New-MenuItem '목록에서만 지우기' $entry { param($sender) Remove-Resume $sender.Tag.id }))
        [void]$item.DropDownItems.Add((New-MenuItem '폐기 (폰에서도 지움)' $entry {
                    param($sender)
                    Remove-Resume $sender.Tag.id
                    [void](Start-Send (" -CancelId {0} -CancelCount {1}" -f $sender.Tag.id, $sender.Tag.count) -Cancel)
                }))
        [void]$miResume.DropDownItems.Add($item)
    }
}
$menu.Add_Opening({ Update-ResumeMenu })
Update-ResumeMenu
$miStop.Add_Click({ Stop-Send 150 })
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
$script:quitting = $false
$miQuit.Add_Click({
    $script:quitting = $true
    if ($script:proc -and -not $script:proc.HasExited) {
        Stop-Send 0
        if (-not $script:proc.WaitForExit(150000)) { Kill-Send }
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
    $stopSignal.Dispose()
    $mutex.ReleaseMutex()
}
