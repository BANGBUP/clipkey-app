param(
    [string]$Text,
    [string]$Path,
    [ValidateRange(5, 1000)][int]$DelayMs = 5,
    [string]$Parts,
    [ValidateRange(64, 32768)][int]$FrameBytes = 1024,
    [string]$CancelId,
    [int]$CancelCount,
    [switch]$NoCompress,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ClipKeyVersion = '1.1.2'
$PartHeader = 9
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
public static System.Threading.WaitHandle Stop;
public static bool SendSymbols(int[] symbols, int start, int count, int delayMs) {
    for (int i = start; i < start + count; i++) {
        if (Stop != null && Stop.WaitOne(0)) return false;
        bool n = (symbols[i] & 1) != 0, c = (symbols[i] & 2) != 0;
        if (n != Num) { Flip(0x90, 0x45, 1); Num = n; }
        if (c != Caps) { Flip(0x14, 0x3A, 0); Caps = c; }
        Flip(0x91, 0x46, 0); Scroll = !Scroll;
        System.Threading.Thread.Sleep(delayMs);
    }
    return true;
}
static uint[] crcTable;
public static uint Crc32(byte[] data) {
    if (crcTable == null) {
        var t = new uint[256];
        for (uint i = 0; i < 256; i++) { uint c = i; for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1; t[i] = c; }
        crcTable = t;
    }
    uint crc = 0xFFFFFFFF;
    foreach (byte b in data) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFF;
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
function Read-Parts([string]$text, [int]$max) {
    $list = New-Object System.Collections.Generic.List[int]
    foreach ($item in ($text -split '[,\s]+' | Where-Object { $_ })) {
        if ($item -notmatch '^(\d{1,5})(?:-(\d{1,5}))?$') { return $null }
        $from = [int]$Matches[1]
        $to = if ($Matches[2]) { [int]$Matches[2] } else { $from }
        if ($from -lt 1 -or $from -gt $to -or $to -gt $max) { return $null }
        foreach ($n in $from..$to) { $list.Add($n) }
    }
    if ($list.Count -eq 0) { return $null }
    , [int[]]($list | Sort-Object -Unique)
}
function Format-Parts([int[]]$numbers) {
    $runs = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $numbers.Count) {
        $j = $i
        while ($j + 1 -lt $numbers.Count -and $numbers[$j + 1] -eq $numbers[$j] + 1) { $j++ }
        $run = if ($j -eq $i) { "$($numbers[$i])" } elseif ($j -eq $i + 1) { "$($numbers[$i]),$($numbers[$j])" } else { "$($numbers[$i])-$($numbers[$j])" }
        $runs.Add($run)
        $i = $j + 1
    }
    $runs -join ','
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
function Get-LE([uint64]$value, [int]$bytes) {
    , [byte[]](0..($bytes - 1) | ForEach-Object { [byte](($value -shr (8 * $_)) -band 0xFF) })
}
$name = $null
if ($CancelId) {
    if ($CancelId -notmatch '^[0-9a-fA-F]{1,8}$' -or $CancelCount -lt 1 -or $CancelCount -gt 65535) {
        Write-Host '폐기할 묶음 번호(16진수)와 조각 수를 넣으세요. 예: -CancelId 1a2b3c4d -CancelCount 14' -ForegroundColor Red
        exit 1
    }
    $payload = [byte[]](@([byte]5) + (Get-LE ([Convert]::ToUInt32($CancelId, 16)) 4) + (Get-LE $CancelCount 2))
    $what = "폐기 신호(묶음 {0})" -f $CancelId.ToLower()
    $preview = $what
    $raw = $payload
    $compressed = $false
} elseif ($Path) {
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
    $label = $file.Name
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
    if (-not $compressed -and $raw[0] -le 5) { $body = @{ Bytes = (Compress-Bytes $raw) }; $compressed = $true }
    $payload = if ($compressed) { [byte[]](@([byte]0) + $body.Bytes) } else { $raw }
    $what = "{0}자 {1}바이트" -f [Globalization.StringInfo]::new($Text).LengthInTextElements, $raw.Length
    $cut = 40
    if ($Text.Length -gt $cut -and [char]::IsHighSurrogate($Text[$cut - 1])) { $cut-- }
    $preview = if ($Text.Length -gt $cut) { $Text.Substring(0, $cut) + '...' } else { $Text }
    $label = "{0} 텍스트 {1}자" -f $(if ($fromClipboard) { '클립보드' } else { '보낸' }), [Globalization.StringInfo]::new($Text).LengthInTextElements
}
$frames = New-Object System.Collections.Generic.List[object]
$partNote = ''
$frameParts = New-Object System.Collections.Generic.List[int]
if ($CancelId -or ($payload.Length -le $FrameBytes -and -not $Parts)) {
    $frames.Add($payload)
    $frameParts.Add(0)
} else {
    $partSize = $FrameBytes - $PartHeader
    $pieceCount = [int][math]::Ceiling($payload.Length / $partSize)
    if ($pieceCount -gt 65535) {
        Write-Host ("너무 큽니다: {0}" -f $what) -ForegroundColor Red
        exit 1
    }
    $id = [ClipKey.LedKeys]::Crc32($payload)
    $pick = if ($Parts) { Read-Parts $Parts $pieceCount } else { 1..$pieceCount }
    if (-not $pick) {
        Write-Host ("조각 번호는 1부터 {0}까지, 3,5,8-40 처럼 넣으세요: {1}" -f $pieceCount, $Parts) -ForegroundColor Red
        exit 1
    }
    $nameBytes = [Text.Encoding]::UTF8.GetBytes($label)
    if ($nameBytes.Length -gt 200) { $nameBytes = [Text.Encoding]::UTF8.GetBytes($label.Substring(0, [math]::Min($label.Length, 60))) }
    $frames.Add([byte[]](@([byte]3) + (Get-LE $id 4) + (Get-LE $pieceCount 2) + (Get-LE $raw.Length 4) + @([byte]$nameBytes.Length) + $nameBytes))
    $frameParts.Add(0)
    $idBytes = Get-LE $id 4
    $countBytes = Get-LE $pieceCount 2
    foreach ($n in $pick) {
        $start = ($n - 1) * $partSize
        $piece = New-Object byte[] ([math]::Min($partSize, $payload.Length - $start))
        [Array]::Copy($payload, $start, $piece, 0, $piece.Length)
        $header = [byte[]](@([byte]4) + $idBytes + (Get-LE ($n - 1) 2) + $countBytes)
        $frames.Add([byte[]]($header + $piece))
        $frameParts.Add($n)
    }
    $partNote = if ($Parts) { ", 조각 {0}만(전체 {1}개)" -f (Format-Parts $pick), $pieceCount } else { ", 조각 {0}개로 나눔" -f $pieceCount }
    Write-Host ("묶음 {0:x8} 조각 {1}개: {2}" -f $id, $pieceCount, $label)
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
$RestoreLimitS = 110
$SteadyS = 5
function Restore-Locks {
    $Num.State = [ClipKey.LedKeys]::Num
    $Caps.State = [ClipKey.LedKeys]::Caps
    $Scroll.State = [ClipKey.LedKeys]::Scroll
    Start-Sleep -Milliseconds $DelayMs
    foreach ($key in $AllKeys) { Set-Key $key $key.Original }
    $limit = [Diagnostics.Stopwatch]::StartNew()
    for ($round = 0; $round -le 2; $round++) {
        $last = $null
        $steady = [Diagnostics.Stopwatch]::StartNew()
        $wrong = @()
        while ($limit.Elapsed.TotalSeconds -lt $RestoreLimitS) {
            Start-Sleep -Milliseconds 100
            $now = ($AllKeys | ForEach-Object { Get-Toggled $_ }) -join ','
            if ($now -ne $last) { $last = $now; $steady.Restart() }
            $wrong = @($AllKeys | Where-Object { (Get-Toggled $_) -ne $_.Original })
            if (-not $wrong) { return $true }
            if ($steady.Elapsed.TotalSeconds -ge $SteadyS) { break }
        }
        if ($limit.Elapsed.TotalSeconds -ge $RestoreLimitS) { return $false }
        foreach ($key in $wrong) { Switch-Key $key }
    }
    $false
}
$done = 0
$partsLeft = @()
$step = 256
$clock = [Diagnostics.Stopwatch]::StartNew()
[ClipKey.LedKeys]::Num = $Num.State
[ClipKey.LedKeys]::Caps = $Caps.State
[ClipKey.LedKeys]::Scroll = $Scroll.State
$stop = $null
try { $stop = [Threading.EventWaitHandle]::OpenExisting('ClipKeySendStop') } catch { }
[ClipKey.LedKeys]::Stop = $stop
$stopped = $false
try {
    for ($p = 0; $p -lt $symbolSets.Count -and -not $stopped; $p++) {
        $symbols = $symbolSets[$p]
        if ($p -gt 0) { Start-Sleep -Milliseconds $PartGapMs }
        $partsLeft = @($frameParts | Select-Object -Skip $p | Where-Object { $_ -gt 0 })
        $sent = 0
        while ($sent -lt $symbols.Length) {
            $count = [math]::Min($step, $symbols.Length - $sent)
            if (-not [ClipKey.LedKeys]::SendSymbols($symbols, $sent, $count, $DelayMs)) { $stopped = $true; break }
            $sent += $count
            $done += $count
            $status = "{0}/{1}바이트" -f [int]($done / 4), [int]($totalSymbols / 4)
            if ($frameParts[$p] -gt 0) { $status = "조각 {0}/{1}, {2}" -f $frameParts[$p], $pieceCount, $status }
            elseif ($symbolSets.Count -gt 1) { $status = "알림, {0}" -f $status }
            Write-Progress -Activity 'ClipKey로 보내는 중' -Status $status -PercentComplete (100 * $done / $totalSymbols)
        }
    }
    Write-Progress -Activity 'ClipKey로 보내는 중' -Completed
    if (-not $stopped) {
        Write-Host ("PC에서 다 보냈습니다: {0}{1}, {2}. 제대로 받았는지는 폰 앱의 받기 탭에서 확인하세요." -f $what, $partNote, (Format-Duration $clock.Elapsed.TotalSeconds)) -ForegroundColor Green
    }
}
finally {
    try { [Console]::TreatControlCAsInput = $true; Write-Host '잠금 키를 원래대로 되돌리는 중...' } catch { }
    $restored = Restore-Locks
    [void][ClipKey.LedKeys]::timeEndPeriod(1)
    if ($stop) { $stop.Dispose() }
    if (-not $restored) {
        Write-Host '잠금 키(넘락·캡스락·스크롤락)를 원래대로 되돌리지 못했습니다. 직접 눌러 맞춰 주세요.' -ForegroundColor Red
    }
    if ($done -lt $totalSymbols) {
        Write-Host '전송이 중간에 멈췄습니다. 기기는 2초 뒤 받던 내용을 버립니다.' -ForegroundColor Red
        if ($partsLeft) {
            Write-Host ("이어 보내기: 트레이의 '이어 보내기' 또는 같은 명령에 -Parts {0}" -f (Format-Parts $partsLeft)) -ForegroundColor Yellow
        }
    }
}
