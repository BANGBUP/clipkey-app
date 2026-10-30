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
$form = New-Object Windows.Forms.Form
$form.Text = '받기'
$form.Size = New-Object Drawing.Size(560, 420)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.KeyPreview = $true
$form.ImeMode = 'Disable'
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
$btnClear = New-Button '비우기'
$btnSave = New-Button '저장'
$btnCopy = New-Button '복사'
$btnSave.Enabled = $false
$btnCopy.Enabled = $false
$form.Controls.AddRange(@($preview, $buttons, $status))
function Set-Status([string]$text, [string]$color = 'Black') {
    $status.Text = $text
    $status.ForeColor = [Drawing.Color]::$color
}
Set-Status '대기 중'
$script:lastText = $null
$script:lastFile = $null
function Save-File {
    $dialog = New-Object Windows.Forms.SaveFileDialog
    $dialog.FileName = $script:lastFile.Name
    $dialog.InitialDirectory = $Downloads
    $dialog.Title = '저장'
    if ($dialog.ShowDialog($form) -eq 'OK') {
        [IO.File]::WriteAllBytes($dialog.FileName, $script:lastFile.Bytes)
        Set-Status ("저장: {0}" -f $dialog.FileName) 'DarkGreen'
    }
}
function Copy-Text {
    if ($script:lastText) { [Windows.Forms.Clipboard]::SetDataObject($script:lastText, $true, 5, 100) }
}
function Restore-Payload([byte[]]$payload, [string]$took) {
    if ($payload[0] -eq 1) {
        if ($payload.Length -lt 3 -or $payload[2] -eq 0 -or 3 + $payload[2] -gt $payload.Length) { throw '파일 정보' }
        $nameEnd = 3 + $payload[2]
        $name = [Text.Encoding]::UTF8.GetString($payload, 3, $payload[2])
        $name = ($name -replace '[\\/:*?"<>|]', '_')
        $bytes = if ($payload[1] -band 1) { Expand-Bytes $payload $nameEnd } else { Get-Slice $payload $nameEnd }
        $script:lastFile = @{ Name = $name; Bytes = $bytes }
        $btnSave.Enabled = $true
        $preview.Text = "{0} ({1}바이트)" -f $name, $bytes.Length
        Set-Status ("완료: {0} {1}바이트{2}" -f $name, $bytes.Length, $took) 'DarkGreen'
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
    Set-Status ("완료: {0}자, 클립보드에 복사함{1}" -f $text.Length, $took) 'DarkGreen'
}
function Restore-Typed([string]$typed, [string]$took = '') {
    $m = [regex]::Match($typed, '\[CK1\.(\d+)\.([A-Za-z0-9+/=\s]*)\]')
    if (-not $m.Success) {
        Set-Status '오류: 형식' 'Red'
        return
    }
    $data = $m.Groups[2].Value -replace '\s', ''
    $want = 0
    [void][int]::TryParse($m.Groups[1].Value, [ref]$want)
    if ($data.Length -ne $want) {
        Set-Status ("오류: 글자 수 {0}/{1}" -f $data.Length, $want) 'Red'
        return
    }
    try {
        $all = [Convert]::FromBase64String($data)
    } catch {
        Set-Status '오류: 글자 깨짐' 'Red'
        return
    }
    $n = $all.Length - 4
    if ($n -lt 1 -or [ClipKey.Unpack]::Crc32($all, $n) -ne [BitConverter]::ToUInt32($all, $n)) {
        Set-Status '오류: 확인값' 'Red'
        return
    }
    $payload = New-Object byte[] $n
    [Array]::Copy($all, $payload, $n)
    try {
        Restore-Payload $payload $took
    } catch {
        Set-Status ("오류: {0}" -f $_.Exception.Message) 'Red'
    }
}
$buf = New-Object Text.StringBuilder
$script:want = -1
$script:head = 0
$clock = New-Object Diagnostics.Stopwatch
$script:covered = $false
function Reset-Receive {
    [void]$buf.Clear()
    $script:want = -1
    $script:head = 0
}
function Clear-View {
    Reset-Receive
    $script:lastText = $null
    $script:lastFile = $null
    $btnCopy.Enabled = $false
    $btnSave.Enabled = $false
    $preview.Text = ''
}
function Add-Char([char]$c) {
    if ($c -eq '[') {
        Clear-View
        [void]$buf.Append($c)
        $clock.Restart()
        return
    }
    if ($buf.Length -eq 0) { return }
    [void]$buf.Append($c)
    if ($c -eq ']') {
        $clock.Stop()
        $s = $clock.Elapsed.TotalSeconds
        $chars = $buf.Length
        $took = ", {0:N1}초, 초당 {1:N0}자" -f $s, ($chars / [math]::Max($s, 0.001))
        $typed = $buf.ToString()
        Reset-Receive
        Restore-Typed $typed $took
        return
    }
    if ($buf.Length -eq $Prefix.Length -and $buf.ToString() -cne $Prefix) {
        $got = $buf.ToString()
        Reset-Receive
        Set-Status ("오류: 시작 {0}" -f $got) 'Red'
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
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    if ($buf.Length -eq 0) { return }
    if ($script:covered) {
        Set-Status '창이 가려짐' 'Red'
        return
    }
    $s = [math]::Max($clock.Elapsed.TotalSeconds, 0.001)
    if ($script:want -gt 0) {
        $got = $buf.Length - $script:head
        $left = ($script:want - $got) / [math]::Max($got / $s, 1)
        Set-Status ("받는 중 {0}/{1}자 ({2}%), 초당 {3:N0}자, 남은 {4:N0}초" -f $got, $script:want, [int](100 * $got / $script:want), ($got / $s), $left) 'DarkOrange'
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
$form.Add_Deactivate({ $script:covered = $true })
$form.Add_Activated({ $script:covered = $false })
$btnCopy.Add_Click({ Copy-Text; Set-Status '복사함' 'DarkGreen' })
$btnClear.Add_Click({ Clear-View; Set-Status '대기 중' })
$btnSave.Add_Click({ Save-File })
$btnClose.Add_Click({ $form.Close() })
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
$timer.Dispose()
