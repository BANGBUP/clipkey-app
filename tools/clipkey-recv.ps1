<#
.SYNOPSIS
  폰 앱의 '트레이로 압축 보내기'를 받는 창입니다. ClipKey가 이 창에 치는 글자를 모아
  확인한 뒤 텍스트는 PC 클립보드로, 파일은 저장 창으로 복원합니다.

.EXAMPLE
  powershell -STA -ExecutionPolicy Bypass -File clipkey-recv.ps1
  (-WindowStyle Hidden을 붙이면 이 창까지 숨겨집니다. 보통은 트레이 메뉴로 엽니다.)

.NOTES
  받는 동안 이 창이 앞에 있어야 합니다(다른 창이 앞이면 그 창에 글자가 쳐짐).
  메모장 등에 쳐진 글자를 복사해 두었다면 이 창에서 Ctrl+V로도 복원합니다.
  쳐지는 글자: [CK1.<글자 수>.<base64>]
  base64를 풀면 내용 + CRC-32(4바이트, 낮은 바이트부터).
  내용: UTF-8 텍스트, 0x00 + deflate 텍스트, 또는 0x01, 압축 여부(1|0), 이름 길이, 이름, 파일 데이터
  (clipkey-send.ps1이 폰으로 보내는 것과 같은 모양, web/js/packed.js 참고)
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace ClipKey -Name Unpack -MemberDefinition @'
static uint[] table;
public static uint Crc32(byte[] data, int count) {
    if (table == null) {
        table = new uint[256];
        for (uint i = 0; i < 256; i++) {
            uint c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
    }
    uint crc = 0xFFFFFFFFu;
    for (int i = 0; i < count; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}
'@
$Prefix = '[CK1.'
$PreviewMax = 3000
$Downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'

function Expand-Bytes([byte[]]$data, [int]$offset) {
    $in = [IO.MemoryStream]::new($data, $offset, $data.Length - $offset)
    $deflate = New-Object IO.Compression.DeflateStream($in, [IO.Compression.CompressionMode]::Decompress)
    $out = New-Object IO.MemoryStream
    $deflate.CopyTo($out)
    $deflate.Close()
    , $out.ToArray()
}

function Get-Slice([byte[]]$data, [int]$offset) {
    $part = New-Object byte[] ($data.Length - $offset)
    [Array]::Copy($data, $offset, $part, 0, $part.Length)
    , $part
}

# ---- 창 ----
$form = New-Object Windows.Forms.Form
$form.Text = 'ClipKey 받기 (폰에서 압축 보내기)'
$form.Size = New-Object Drawing.Size(560, 420)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.KeyPreview = $true
$form.ImeMode = 'Disable' # 한글 입력기가 글자를 자모로 바꾸지 않게

$status = New-Object Windows.Forms.Label
$status.Dock = 'Top'
$status.Height = 60
$status.Font = New-Object Drawing.Font('Malgun Gothic', 11)
$status.Padding = New-Object Windows.Forms.Padding(8)

$preview = New-Object Windows.Forms.TextBox
$preview.Multiline = $true
$preview.ReadOnly = $true
$preview.ScrollBars = 'Vertical'
$preview.Dock = 'Fill'
$preview.TabStop = $false
$preview.ImeMode = 'Disable'
$preview.Font = New-Object Drawing.Font('Consolas', 9)

$buttons = New-Object Windows.Forms.FlowLayoutPanel
$buttons.Dock = 'Bottom'
$buttons.Height = 40
$buttons.FlowDirection = 'RightToLeft'
function New-Button([string]$text) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text
    $b.AutoSize = $true
    $b.TabStop = $false
    $b.ImeMode = 'Disable'
    [void]$buttons.Controls.Add($b)
    $b
}
$btnClose = New-Button '닫기'
$btnSave = New-Button '파일 다시 저장'
$btnCopy = New-Button '텍스트 다시 복사'
$btnPaste = New-Button '클립보드에서 복원 (Ctrl+V)'
$btnSave.Enabled = $false
$btnCopy.Enabled = $false
$form.Controls.AddRange(@($preview, $buttons, $status))

function Set-Status([string]$text, [string]$color = 'Black') {
    $status.Text = $text
    $status.ForeColor = [Drawing.Color]::$color
}
$Waiting = "기다리는 중: 폰 앱 보내기 탭에서 '트레이로 압축 보내기'를 누르세요.`n받는 동안 이 창을 앞에 두고 키보드를 쓰지 마세요."
Set-Status $Waiting

# ---- 받은 내용 복원 ----
$script:lastText = $null
$script:lastFile = $null

function Save-File {
    $dialog = New-Object Windows.Forms.SaveFileDialog
    $dialog.FileName = $script:lastFile.Name
    $dialog.InitialDirectory = $Downloads
    $dialog.Title = 'ClipKey로 받은 파일 저장'
    if ($dialog.ShowDialog($form) -eq 'OK') {
        [IO.File]::WriteAllBytes($dialog.FileName, $script:lastFile.Bytes)
        Set-Status ("저장했습니다: {0}" -f $dialog.FileName) 'DarkGreen'
    }
}

function Copy-Text {
    # 다른 프로그램이 클립보드를 잡고 있으면 0.1초 간격으로 5번 다시 시도
    if ($script:lastText) { [Windows.Forms.Clipboard]::SetDataObject($script:lastText, $true, 5, 100) }
}

function Restore-Payload([byte[]]$payload, [string]$took) {
    if ($payload[0] -eq 1) {
        if ($payload.Length -lt 3 -or $payload[2] -eq 0 -or 3 + $payload[2] -gt $payload.Length) { throw '파일 정보가 잘못되었습니다' }
        $nameEnd = 3 + $payload[2]
        $name = [Text.Encoding]::UTF8.GetString($payload, 3, $payload[2])
        $name = ($name -replace '[\\/:*?"<>|]', '_')
        $bytes = if ($payload[1] -band 1) { Expand-Bytes $payload $nameEnd } else { Get-Slice $payload $nameEnd }
        $script:lastFile = @{ Name = $name; Bytes = $bytes }
        $btnSave.Enabled = $true
        $preview.Text = "파일 {0} ({1}바이트)" -f $name, $bytes.Length
        Set-Status ("받았습니다: 파일 {0} {1}바이트{2}" -f $name, $bytes.Length, $took) 'DarkGreen'
        Save-File
        return
    }
    $text = if ($payload[0] -eq 0) {
        [Text.Encoding]::UTF8.GetString((Expand-Bytes $payload 1))
    } else {
        [Text.Encoding]::UTF8.GetString($payload)
    }
    $script:lastText = $text
    $btnCopy.Enabled = $true
    $preview.Text = if ($text.Length -gt $PreviewMax) { $text.Substring(0, $PreviewMax) + "`r`n(이하 생략)" } else { $text }
    Copy-Text
    Set-Status ("받았습니다: 텍스트 {0}자, PC 클립보드에 복사했습니다{1}" -f $text.Length, $took) 'DarkGreen'
}

# "[CK1.<n>.<base64>]" 하나를 확인하고 복원합니다. 실패하면 이유를 보여 줍니다.
function Restore-Typed([string]$typed, [string]$took = '') {
    $m = [regex]::Match($typed, '\[CK1\.(\d+)\.([A-Za-z0-9+/=\s]*)\]')
    if (-not $m.Success) {
        Set-Status '받은 글자에서 ClipKey 압축 내용을 찾지 못했습니다.' 'Red'
        return
    }
    $data = $m.Groups[2].Value -replace '\s', ''
    $want = 0
    [void][int]::TryParse($m.Groups[1].Value, [ref]$want)
    if ($data.Length -ne $want) {
        Set-Status ("글자가 빠지거나 더 들어왔습니다: 받은 {0}자 / 보낸 {1}자. 폰 설정의 압축 보내기 키 간격을 늘려 다시 보내세요." -f $data.Length, $want) 'Red'
        return
    }
    try {
        $all = [Convert]::FromBase64String($data)
    } catch {
        Set-Status '글자가 깨졌습니다(base64 아님). 키 간격을 늘려 다시 보내세요.' 'Red'
        return
    }
    $n = $all.Length - 4
    if ($n -lt 1 -or [ClipKey.Unpack]::Crc32($all, $n) -ne [BitConverter]::ToUInt32($all, $n)) {
        Set-Status '확인값이 맞지 않습니다(글자가 바뀜). 키 간격을 늘려 다시 보내세요.' 'Red'
        return
    }
    $payload = New-Object byte[] $n
    [Array]::Copy($all, $payload, $n)
    try {
        Restore-Payload $payload $took
    } catch {
        Set-Status ("복원하지 못했습니다: {0}" -f $_.Exception.Message) 'Red'
    }
}

# ---- 쳐지는 글자 받기 ----
$buf = New-Object Text.StringBuilder
$script:want = -1 # 머리("[CK1.<n>.") 다음에 올 글자 수, 모르면 -1
$script:head = 0
$clock = New-Object Diagnostics.Stopwatch
$script:covered = $false # 받는 중에 다른 창이 앞으로 왔음

function Reset-Receive {
    [void]$buf.Clear()
    $script:want = -1
    $script:head = 0
}

function Add-Char([char]$c) {
    if ($c -eq '[') {
        Reset-Receive
        [void]$buf.Append($c)
        $clock.Restart()
        return
    }
    if ($buf.Length -eq 0) { return } # 시작 전 글자는 무시
    [void]$buf.Append($c)
    if ($c -eq ']') {
        $clock.Stop()
        $s = $clock.Elapsed.TotalSeconds
        $chars = $buf.Length
        $took = ", {0:N1}초 (초당 {1:N0}자)" -f $s, ($chars / [math]::Max($s, 0.001))
        $typed = $buf.ToString()
        Reset-Receive
        Restore-Typed $typed $took
        return
    }
    if ($buf.Length -eq $Prefix.Length -and $buf.ToString() -cne $Prefix) {
        $got = $buf.ToString()
        Reset-Receive
        Set-Status ("시작 표시가 다릅니다: {0} (Caps Lock이나 한/영 상태를 확인하세요)" -f $got) 'Red'
        return
    }
    if ($script:want -lt 0 -and $c -eq '.' -and $buf.Length -gt $Prefix.Length) {
        $m = [regex]::Match($buf.ToString(), '^\[CK1\.(\d+)\.$')
        $n = 0
        if ($m.Success -and [int]::TryParse($m.Groups[1].Value, [ref]$n)) {
            $script:want = $n
            $script:head = $buf.Length
        }
    }
}

# 진행 표시는 0.2초마다(글자마다 그리면 느려짐)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    if ($buf.Length -eq 0) { return }
    if ($script:covered) {
        Set-Status '받는 중에 창이 가려졌습니다! 이 창을 눌러 앞으로 가져오세요(다른 창에 글자가 쳐집니다).' 'Red'
        return
    }
    $s = [math]::Max($clock.Elapsed.TotalSeconds, 0.001)
    if ($script:want -gt 0) {
        $got = $buf.Length - $script:head
        $left = ($script:want - $got) / [math]::Max($got / $s, 1)
        Set-Status ("받는 중 {0}/{1}자 ({2}%), 초당 {3:N0}자, 남은 시간 약 {4:N0}초`n이 창을 앞에 두고 키보드를 쓰지 마세요." -f $got, $script:want, [int](100 * $got / $script:want), ($got / $s), $left) 'DarkOrange'
    } else {
        Set-Status ("받는 중 {0}자" -f $buf.Length) 'DarkOrange'
    }
})
$timer.Start()

$form.Add_KeyPress({
    param($s, $e)
    $e.Handled = $true
    if ($e.KeyChar -ge ' ') { Add-Char $e.KeyChar }
})
$form.Add_KeyDown({
    param($s, $e)
    if ($e.Control -and $e.KeyCode -eq 'V') {
        $e.Handled = $true
        $btnPaste.PerformClick()
    }
})
$form.Add_Deactivate({ $script:covered = $true })
$form.Add_Activated({ $script:covered = $false })
$btnPaste.Add_Click({
    $text = [Windows.Forms.Clipboard]::GetText()
    if ($text) { Restore-Typed $text } else { Set-Status '클립보드에 텍스트가 없습니다.' 'Red' }
})
$btnCopy.Add_Click({ Copy-Text; Set-Status '텍스트를 다시 복사했습니다.' 'DarkGreen' })
$btnSave.Add_Click({ Save-File })
$btnClose.Add_Click({ $form.Close() })
$form.Add_Shown({ $form.Activate() })

[void]$form.ShowDialog()
$timer.Dispose()
