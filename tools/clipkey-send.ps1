param(
    [string]$Text,
    [string]$Path,
    [ValidateRange(5, 1000)][int]$DelayMs = 5,
    [string]$Parts,
    [ValidateRange(64, 32768)][int]$FrameBytes = 32768,
    [switch]$NoCompress,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$PartHeader = 7
$PartGapMs = 500
Add-Type -Namespace ClipKey -Name LedKeys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern short GetKeyState(int vk);
[DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
[DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
public static bool Num, Caps, Scroll;
static void Flip(byte vk, byte scan, uint ext) {
    keybd_event(vk, scan, ext, System.UIntPtr.Zero);
    keybd_event(vk, scan, ext | 2, System.UIntPtr.Zero);
}
public static void SendSymbols(int[] symbols, int start, int count, int delayMs) {
    for (int i = start; i < start + count; i++) {
        bool n = (symbols[i] & 1) != 0, c = (symbols[i] & 2) != 0;
        if (n != Num) { Flip(0x90, 0x45, 1); Num = n; }
        if (c != Caps) { Flip(0x14, 0x3A, 0); Caps = c; }
        Flip(0x91, 0x46, 0); Scroll = !Scroll;
        System.Threading.Thread.Sleep(delayMs);
    }
}
'@
$KEYUP = 0x2
$EXTENDED = 0x1
$Num = @{ Vk = 0x90; Scan = 0x45; Ext = $true }
$Caps = @{ Vk = 0x14; Scan = 0x3A; Ext = $false }
$Scroll = @{ Vk = 0x91; Scan = 0x46; Ext = $false }
$AllKeys = @($Num, $Caps, $Scroll)
function Get-Toggled($key) {
    ([ClipKey.LedKeys]::GetKeyState($key.Vk) -band 1) -eq 1
}
function Switch-Key($key) {
    $flags = if ($key.Ext) { $EXTENDED } else { 0 }
    [ClipKey.LedKeys]::keybd_event([byte]$key.Vk, [byte]$key.Scan, $flags, [UIntPtr]::Zero)
    [ClipKey.LedKeys]::keybd_event([byte]$key.Vk, [byte]$key.Scan, $flags -bor $KEYUP, [UIntPtr]::Zero)
    $key.State = -not $key.State
}
function Set-Key($key, [bool]$on) {
    if ($key.State -ne $on) { Switch-Key $key }
}
function Get-Symbols([int[]]$sync, [byte[]]$frame) {
    $list = New-Object System.Collections.Generic.List[int]
    foreach ($symbol in $sync) { $list.Add($symbol) }
    foreach ($b in $frame) { for ($i = 0; $i -lt 4; $i++) { $list.Add(($b -shr (2 * $i)) -band 3) } }
    , $list.ToArray()
}
function Format-Duration([double]$seconds) {
    $s = [int][math]::Ceiling($seconds)
    if ($s -lt 60) { return "{0}초" -f $s }
    return "{0}분 {1}초" -f [int][math]::Floor($s / 60), ($s % 60)
}
function Compress-Bytes([byte[]]$data) {
    $out = New-Object System.IO.MemoryStream
    $deflate = New-Object System.IO.Compression.DeflateStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
    $deflate.Write($data, 0, $data.Length)
    $deflate.Close()
    , $out.ToArray()
}
function Get-Crc16([byte[]]$data) {
    $crc = 0xFFFF
    foreach ($b in $data) {
        $crc = $crc -bxor ([int]$b -shl 8)
        for ($i = 0; $i -lt 8; $i++) {
            if ($crc -band 0x8000) { $crc = (($crc -shl 1) -bxor 0x1021) -band 0xFFFF }
            else { $crc = ($crc -shl 1) -band 0xFFFF }
        }
    }
    $crc
}
function Get-Smaller([byte[]]$data) {
    if (-not $NoCompress -and $data.Length -gt 0) {
        $packed = Compress-Bytes $data
        if ($packed.Length -lt $data.Length) { return @{ Bytes = $packed; Packed = $true } }
    }
    @{ Bytes = $data; Packed = $false }
}
if ($Path) {
    $file = Get-Item -LiteralPath $Path
    $raw = [IO.File]::ReadAllBytes($file.FullName)
    $name = [Text.Encoding]::UTF8.GetBytes($file.Name)
    if ($name.Length -gt 200) { $name = [Text.Encoding]::UTF8.GetBytes('file' + $file.Extension) }
    $body = Get-Smaller $raw
    $compressed = $body.Packed
    $flags = if ($compressed) { 1 } else { 0 }
    $payload = [byte[]](@([byte]1, [byte]$flags, [byte]$name.Length) + $name + $body.Bytes)
    $what = "파일 {0} {1}바이트" -f $file.Name, $raw.Length
    $preview = $file.Name
} else {
    $fromClipboard = -not $PSBoundParameters.ContainsKey('Text')
    if ($fromClipboard) {
        $Text = Get-Clipboard -Raw
    }
    if ([string]::IsNullOrEmpty($Text)) {
        $why = if ($fromClipboard) { '클립보드가 비어 있습니다' } else { '-Text 값이 비어 있습니다' }
        Write-Host "보낼 텍스트가 없습니다: $why." -ForegroundColor Red
        exit 1
    }
    $raw = [Text.Encoding]::UTF8.GetBytes($Text)
    $body = Get-Smaller $raw
    $compressed = $body.Packed
    if (-not $compressed -and $raw[0] -le 2) { $body = @{ Bytes = (Compress-Bytes $raw) }; $compressed = $true }
    $payload = if ($compressed) { [byte[]](@([byte]0) + $body.Bytes) } else { $raw }
    $what = "{0}자 {1}바이트" -f [Globalization.StringInfo]::new($Text).LengthInTextElements, $raw.Length
    $cut = 40
    if ($Text.Length -gt $cut -and [char]::IsHighSurrogate($Text[$cut - 1])) { $cut-- }
    $preview = if ($Text.Length -gt $cut) { $Text.Substring(0, $cut) + '...' } else { $Text }
}
$frames = New-Object System.Collections.Generic.List[object]
$partNote = ''
$partNumbers = @()
if ($payload.Length -le $FrameBytes -and -not $Parts) {
    $frames.Add($payload)
} else {
    $partSize = $FrameBytes - $PartHeader
    $count = [int][math]::Ceiling($payload.Length / $partSize)
    if ($count -gt 65535) {
        Write-Host ("너무 큽니다: {0}" -f $what) -ForegroundColor Red
        exit 1
    }
    $id = Get-Crc16 $payload
    $pick = if ($Parts) { [int[]]($Parts -split '[,\s]+' | Where-Object { $_ }) | Sort-Object -Unique } else { 1..$count }
    foreach ($n in $pick) {
        if ($n -lt 1 -or $n -gt $count) {
            Write-Host ("조각 번호는 1부터 {0}까지입니다: {1}" -f $count, $n) -ForegroundColor Red
            exit 1
        }
        $start = ($n - 1) * $partSize
        $piece = New-Object byte[] ([math]::Min($partSize, $payload.Length - $start))
        [Array]::Copy($payload, $start, $piece, 0, $piece.Length)
        $header = [byte[]]@(2, ($id -band 0xFF), ($id -shr 8), (($n - 1) -band 0xFF), (($n - 1) -shr 8), ($count -band 0xFF), ($count -shr 8))
        $frames.Add([byte[]]($header + $piece))
        $partNumbers += $n
    }
    $partNote = if ($Parts) { ", 조각 {0}만 다시(전체 {1}개)" -f ($pick -join ','), $count } else { ", 조각 {0}개로 나눔" -f $count }
}
$sync = @(3, 0, 3, 0, 1, 2, 1, 2)
$symbolSets = New-Object System.Collections.Generic.List[object]
foreach ($part in $frames) {
    $length = [byte[]]@(($part.Length -band 0xFF), ($part.Length -shr 8))
    $crc = Get-Crc16 ($length + $part)
    $symbolSets.Add((Get-Symbols $sync ($length + $part + [byte[]]@(($crc -band 0xFF), ($crc -shr 8)))))
}
$totalSymbols = ($symbolSets | ForEach-Object { $_.Length } | Measure-Object -Sum).Sum
$seconds = $totalSymbols * ($DelayMs + 1) / 1000 + ($frames.Count - 1) * $PartGapMs / 1000
Write-Host ("보낼 내용: {0}" -f $preview) -ForegroundColor Green
$size = if ($compressed) { ", 압축해서 {0}바이트" -f $payload.Length } else { '' }
Write-Host ("{0}{1}{2}, 예상 약 {3}. 전송 중에는 키보드를 쓰지 마세요. (멈추기: Ctrl+C)" -f $what, $size, $partNote, (Format-Duration $seconds)) -ForegroundColor Yellow
if ($DryRun) {
    foreach ($set in $symbolSets) { Write-Output ($set -join '') }
    exit 0
}
Start-Sleep -Seconds 1
[void][ClipKey.LedKeys]::timeBeginPeriod(1)
foreach ($key in $AllKeys) {
    $key.State = Get-Toggled $key
    $key.Original = $key.State
}
foreach ($key in $AllKeys) {
    for ($i = 0; $i -lt 2; $i++) {
        Switch-Key $key
        Start-Sleep -Milliseconds 80
        if ((Get-Toggled $key) -ne $key.State) {
            Set-Key $key $key.Original
            Write-Host '잠금 키가 키 입력으로 켜고 꺼지지 않습니다.' -ForegroundColor Red
            Write-Host '설정 > 시간 및 언어 > 입력 > 고급 키보드 설정 > 입력 언어 핫키에서 "Caps Lock 해제"를 "Caps Lock 키"로 바꾸세요.' -ForegroundColor Red
            exit 1
        }
    }
}
$done = 0
$partsLeft = $partNumbers
$step = 256
$clock = [Diagnostics.Stopwatch]::StartNew()
[ClipKey.LedKeys]::Num = $Num.State
[ClipKey.LedKeys]::Caps = $Caps.State
[ClipKey.LedKeys]::Scroll = $Scroll.State
try {
    for ($p = 0; $p -lt $symbolSets.Count; $p++) {
        $symbols = $symbolSets[$p]
        if ($p -gt 0) { Start-Sleep -Milliseconds $PartGapMs }
        $partsLeft = $partNumbers | Select-Object -Skip $p
        $sent = 0
        while ($sent -lt $symbols.Length) {
            $count = [math]::Min($step, $symbols.Length - $sent)
            [ClipKey.LedKeys]::SendSymbols($symbols, $sent, $count, $DelayMs)
            $sent += $count
            $done += $count
            $status = "{0}/{1}바이트" -f [int]($done / 4), [int]($totalSymbols / 4)
            if ($symbolSets.Count -gt 1) { $status = "조각 {0}/{1}, {2}" -f ($p + 1), $symbolSets.Count, $status }
            Write-Progress -Activity 'ClipKey로 보내는 중' -Status $status -PercentComplete (100 * $done / $totalSymbols)
        }
    }
    Write-Progress -Activity 'ClipKey로 보내는 중' -Completed
    Write-Host ("보냈습니다: {0}{1}, {2}. 폰 앱의 받기 탭을 확인하세요." -f $what, $partNote, (Format-Duration $clock.Elapsed.TotalSeconds)) -ForegroundColor Green
}
finally {
    $Num.State = [ClipKey.LedKeys]::Num
    $Caps.State = [ClipKey.LedKeys]::Caps
    $Scroll.State = [ClipKey.LedKeys]::Scroll
    Start-Sleep -Milliseconds $DelayMs
    foreach ($key in $AllKeys) { Set-Key $key $key.Original }
    Start-Sleep -Milliseconds 100
    foreach ($key in $AllKeys) {
        if ((Get-Toggled $key) -ne $key.Original) { Switch-Key $key }
    }
    [void][ClipKey.LedKeys]::timeEndPeriod(1)
    if ($done -lt $totalSymbols) {
        Write-Host '전송이 중간에 멈췄습니다. 기기는 2초 뒤 받던 내용을 버립니다.' -ForegroundColor Red
        if ($partsLeft) {
            Write-Host ("남은 조각만 이어서 보내려면 같은 명령에 -Parts {0} 를 붙이세요." -f ($partsLeft -join ',')) -ForegroundColor Yellow
        }
    }
}
