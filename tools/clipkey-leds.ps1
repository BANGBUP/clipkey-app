<#
.SYNOPSIS
  PC가 키보드 표시등 신호를 ClipKey로 보내는지 확인합니다.
  넘락·캡스락·스크롤락(-Kana를 주면 카나도)을 1초마다 켜고 끄고, 끝나면 원래 상태로 되돌립니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File clipkey-leds.ps1               # 5초 동안 1초마다 깜빡임
  powershell -ExecutionPolicy Bypass -File clipkey-leds.ps1 -Seconds 10   # 10초 동안
  powershell -ExecutionPolicy Bypass -File clipkey-leds.ps1 -Kana         # 카나(한/영) 키도 함께

.NOTES
  - 잠금 키 상태는 Windows 전체에 하나라서, 키를 바꾸면 Windows가 연결된 모든 키보드에
    표시등 신호를 보냅니다. ClipKey 앱의 표시등 줄이 같이 깜빡이면 신호가 오가는 것입니다.
  - 컴포즈는 Windows에 해당 키가 없어 켜고 끌 수 없습니다.
  - 카나 키(가상 키 0x15)는 한국어 배열에서 한/영 키와 같은 코드입니다. -Kana를 주면 한/영이
    1초마다 바뀌고, 그때 카나 표시등이 함께 바뀌는지 볼 수 있습니다(끝나면 원래대로 되돌림).
  - 이 스크립트가 키를 누르는 동안 다른 창에서 타이핑하지 마세요.
#>
param(
    [ValidateRange(1, 60)][int]$Seconds = 5,
    [switch]$Kana
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace ClipKey -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern short GetKeyState(int vk);
'@

$KEYEVENTF_EXTENDEDKEY = 0x1
$KEYEVENTF_KEYUP = 0x2

$keys = @(
    @{ Name = '넘락';     Vk = 0x90; Extended = $true },
    @{ Name = '캡스락';   Vk = 0x14; Extended = $false },
    @{ Name = '스크롤락'; Vk = 0x91; Extended = $false }
)
if ($Kana) {
    $keys += @{ Name = '카나(한/영)'; Vk = 0x15; Extended = $false }
}

function Get-Toggled([int]$vk) {
    ([ClipKey.Keys]::GetKeyState($vk) -band 1) -eq 1
}

function Press-Key($key) {
    $flags = if ($key.Extended) { $KEYEVENTF_EXTENDEDKEY } else { 0 }
    [ClipKey.Keys]::keybd_event([byte]$key.Vk, 0, $flags, [UIntPtr]::Zero)
    [ClipKey.Keys]::keybd_event([byte]$key.Vk, 0, $flags -bor $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

function Show-State([string]$prefix) {
    $parts = foreach ($key in $keys) {
        "{0} {1}" -f $key.Name, $(if (Get-Toggled $key.Vk) { '켜짐' } else { '꺼짐' })
    }
    Write-Host ("{0}  {1}" -f $prefix, ($parts -join ' | '))
}

foreach ($key in $keys) {
    $key.Original = Get-Toggled $key.Vk
}

Write-Host "ClipKey 앱의 표시등 줄을 보면서 확인하세요. ${Seconds}초 동안 1초마다 바꿉니다."
Write-Host '(컴포즈는 Windows에서 켜고 끌 수 없어 항상 꺼짐이 정상입니다)'
Show-State '시작  '
try {
    for ($i = 1; $i -le $Seconds; $i++) {
        foreach ($key in $keys) {
            Press-Key $key
        }
        Start-Sleep -Milliseconds 100 # 상태가 반영될 시간
        Show-State ("{0,2}초  " -f $i)
        Start-Sleep -Milliseconds 900
    }
}
finally {
    # 중간에 Ctrl+C로 멈춰도 원래 상태로 되돌립니다.
    foreach ($key in $keys) {
        if ((Get-Toggled $key.Vk) -ne $key.Original) {
            Press-Key $key
        }
    }
    Start-Sleep -Milliseconds 100
    Show-State '복원  '
    Write-Host '끝났습니다.'
}
