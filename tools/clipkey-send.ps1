<#
.SYNOPSIS
  PC 클립보드(또는 -Text)를 키보드 표시등 신호로 ClipKey에 보내, 폰 앱의 '받기' 탭에 띄웁니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File clipkey-send.ps1                 # 클립보드 보내기
  powershell -ExecutionPolicy Bypass -File clipkey-send.ps1 -Text "안녕"    # 직접 입력한 텍스트
  powershell -ExecutionPolicy Bypass -File clipkey-send.ps1 -Path 메모.txt  # 파일 그대로(받기 탭에서 저장)
  powershell -ExecutionPolicy Bypass -File clipkey-send.ps1 -DelayMs 20     # 깨지면 더 천천히
  powershell -ExecutionPolicy Bypass -File clipkey-send.ps1 -DryRun         # 키를 누르지 않고 신호 순서만 출력

.NOTES
  규약 (firmware/src/ledlink.h 와 같아야 함)
  - 스크롤락 = 박자: 한 번 바뀔 때마다 2비트 하나를 전달
  - 넘락(1번째 비트)·캡스락(2번째 비트) = 데이터, 박자보다 먼저 맞춰 둠
  - 1바이트 = 2비트 4개(낮은 비트부터)
  - 묶음 = 시작 신호 3,0,3,0,1,2,1,2 | 길이(2바이트) | 내용 | 확인값 CRC-16(2바이트)
  - 확인값: CRC-16/CCITT(다항식 0x1021, 초기값 0xFFFF), 길이+내용에 대해 계산
  - 내용: UTF-8 텍스트, 또는 압축이 더 짧으면 0x00 + deflate(raw) 압축본(앱이 풀어서 표시)
         파일은 0x01, 압축 여부(1|0), 이름 길이, 이름(UTF-8), 파일 내용(압축이 더 짧으면 deflate)
  - 최대 32768바이트(ESP32-S3). 1세대 ESP32는 4096바이트까지 받습니다.
  전송하는 동안 PC 키보드를 쓰지 마세요(캡스락이 계속 바뀜). 끝나면 잠금 키를 원래대로 되돌립니다.
#>
param(
    [string]$Text,
    [string]$Path,
    [ValidateRange(5, 1000)][int]$DelayMs = 5,
    [switch]$NoCompress,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$MaxBytes = 32768

# 신호 보내기는 C#으로: PowerShell로 키를 누르면 신호 한 번에 약 11 ms가 더 걸렸습니다.
Add-Type -Namespace ClipKey -Name LedKeys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern short GetKeyState(int vk);
[DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
[DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
public static bool Num, Caps, Scroll; // 지금 잠금 상태(직접 기억: 빠르게 바꾸면 GetKeyState가 늦음)
static void Flip(byte vk, byte scan, uint ext) {
    keybd_event(vk, scan, ext, System.UIntPtr.Zero);
    keybd_event(vk, scan, ext | 2, System.UIntPtr.Zero);
}
// 2비트 신호 count개: 데이터(넘락·캡스락)를 먼저 맞추고 박자(스크롤락)를 뒤집은 뒤 delayMs 쉼
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
# Vk: 가상 키, Scan: 스캔 코드, Ext: 확장 키 여부
$Num = @{ Vk = 0x90; Scan = 0x45; Ext = $true }
$Caps = @{ Vk = 0x14; Scan = 0x3A; Ext = $false }
$Scroll = @{ Vk = 0x91; Scan = 0x46; Ext = $false }
$AllKeys = @($Num, $Caps, $Scroll)

function Get-Toggled($key) {
    ([ClipKey.LedKeys]::GetKeyState($key.Vk) -band 1) -eq 1
}

# 키를 한 번 눌러 잠금 상태를 뒤집습니다. 상태는 직접 기억합니다(빠르게 바꾸면 GetKeyState가 늦음).
function Switch-Key($key) {
    $flags = if ($key.Ext) { $EXTENDED } else { 0 }
    [ClipKey.LedKeys]::keybd_event([byte]$key.Vk, [byte]$key.Scan, $flags, [UIntPtr]::Zero)
    [ClipKey.LedKeys]::keybd_event([byte]$key.Vk, [byte]$key.Scan, $flags -bor $KEYUP, [UIntPtr]::Zero)
    $key.State = -not $key.State
}

function Set-Key($key, [bool]$on) {
    if ($key.State -ne $on) { Switch-Key $key }
}

# 보낼 2비트 신호 전체: 시작 신호, 그다음 바이트마다 4개(낮은 비트부터)
function Get-Symbols([int[]]$sync, [byte[]]$frame) {
    $list = New-Object System.Collections.Generic.List[int]
    foreach ($symbol in $sync) { $list.Add($symbol) }
    foreach ($b in $frame) { for ($i = 0; $i -lt 4; $i++) { $list.Add(($b -shr (2 * $i)) -band 3) } }
    , $list.ToArray()
}

# 분·초로: 237 -> "3분 57초"
function Format-Duration([double]$seconds) {
    $s = [int][math]::Ceiling($seconds)
    if ($s -lt 60) { return "{0}초" -f $s }
    return "{0}분 {1}초" -f [int][math]::Floor($s / 60), ($s % 60)
}

# deflate(raw) 압축(앞에 붙는 0x00·0x01 표시는 부르는 쪽에서)
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

# 압축이 더 짧으면 압축본, 아니면 그대로
function Get-Smaller([byte[]]$data) {
    if (-not $NoCompress -and $data.Length -gt 0) {
        $packed = Compress-Bytes $data
        if ($packed.Length -lt $data.Length) { return @{ Bytes = $packed; Packed = $true } }
    }
    @{ Bytes = $data; Packed = $false }
}

# ---- 보낼 내용 ----
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
    if (-not $compressed -and $raw[0] -le 1) { $body = @{ Bytes = (Compress-Bytes $raw) }; $compressed = $true } # 표시 바이트와 헷갈리지 않게
    $payload = if ($compressed) { [byte[]](@([byte]0) + $body.Bytes) } else { $raw }
    $what = "{0}자 {1}바이트" -f [Globalization.StringInfo]::new($Text).LengthInTextElements, $raw.Length
    $cut = 40
    if ($Text.Length -gt $cut -and [char]::IsHighSurrogate($Text[$cut - 1])) { $cut-- } # 이모지 반쪽 방지
    $preview = if ($Text.Length -gt $cut) { $Text.Substring(0, $cut) + '...' } else { $Text }
}
if ($payload.Length -gt $MaxBytes) {
    Write-Host ("너무 큽니다: {0}, 보낼 크기 {1}바이트 (최대 {2}바이트)" -f $what, $payload.Length, $MaxBytes) -ForegroundColor Red
    exit 1
}

$length = [byte[]]@(($payload.Length -band 0xFF), ($payload.Length -shr 8))
$crc = Get-Crc16 ($length + $payload)
$frame = $length + $payload + [byte[]]@(($crc -band 0xFF), ($crc -shr 8))
$sync = @(3, 0, 3, 0, 1, 2, 1, 2)
$symbols = Get-Symbols $sync $frame
$seconds = $symbols.Length * ($DelayMs + 1) / 1000

Write-Host ("보낼 내용: {0}" -f $preview) -ForegroundColor Green
$size = if ($compressed) { ", 압축해서 {0}바이트" -f $payload.Length } else { '' }
Write-Host ("{0}{1}, 예상 약 {2}. 전송 중에는 키보드를 쓰지 마세요. (멈추기: Ctrl+C)" -f $what, $size, (Format-Duration $seconds)) -ForegroundColor Yellow
if ($DryRun) {
    Write-Output ($symbols -join '')
    exit 0
}
Start-Sleep -Seconds 1
[void][ClipKey.LedKeys]::timeBeginPeriod(1) # 1 ms 단위로 쉬기(기본은 약 15.6 ms 단위라 느려짐)

foreach ($key in $AllKeys) {
    $key.State = Get-Toggled $key
    $key.Original = $key.State
}

# 각 잠금 키가 실제로 켜고 꺼지는지 확인합니다. 예: Windows의 "Caps Lock 해제: Shift 키" 설정이면
# 캡스락 키로 끌 수 없어 데이터가 모두 깨집니다.
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
$step = 256 # 신호 256개(64바이트)마다 진행 표시
$clock = [Diagnostics.Stopwatch]::StartNew()
[ClipKey.LedKeys]::Num = $Num.State
[ClipKey.LedKeys]::Caps = $Caps.State
[ClipKey.LedKeys]::Scroll = $Scroll.State
try {
    while ($done -lt $symbols.Length) {
        $count = [math]::Min($step, $symbols.Length - $done)
        [ClipKey.LedKeys]::SendSymbols($symbols, $done, $count, $DelayMs)
        $done += $count
        Write-Progress -Activity 'ClipKey로 보내는 중' -Status ("{0}/{1}바이트" -f [int]($done / 4), $frame.Length) -PercentComplete (100 * $done / $symbols.Length)
    }
    Write-Progress -Activity 'ClipKey로 보내는 중' -Completed
    Write-Host ("보냈습니다: {0}, {1}. 폰 앱의 받기 탭을 확인하세요." -f $what, (Format-Duration $clock.Elapsed.TotalSeconds)) -ForegroundColor Green
}
finally {
    # 끝나거나 중간에 멈춰도 잠금 키를 원래 상태로 되돌립니다.
    $Num.State = [ClipKey.LedKeys]::Num
    $Caps.State = [ClipKey.LedKeys]::Caps
    $Scroll.State = [ClipKey.LedKeys]::Scroll
    Start-Sleep -Milliseconds $DelayMs
    foreach ($key in $AllKeys) { Set-Key $key $key.Original }
    Start-Sleep -Milliseconds 100
    foreach ($key in $AllKeys) {
        if ((Get-Toggled $key) -ne $key.Original) { Switch-Key $key } # 기억한 상태와 어긋났으면 실제 상태 기준으로 복원
    }
    [void][ClipKey.LedKeys]::timeEndPeriod(1)
    if ($done -lt $symbols.Length) {
        Write-Host '전송이 중간에 멈췄습니다. 기기는 2초 뒤 받던 내용을 버립니다.' -ForegroundColor Red
    }
}
