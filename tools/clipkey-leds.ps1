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
        Start-Sleep -Milliseconds 100
        Show-State ("{0,2}초  " -f $i)
        Start-Sleep -Milliseconds 900
    }
}
finally {
    foreach ($key in $keys) {
        if ((Get-Toggled $key.Vk) -ne $key.Original) {
            Press-Key $key
        }
    }
    Start-Sleep -Milliseconds 100
    Show-State '복원  '
    Write-Host '끝났습니다.'
}
