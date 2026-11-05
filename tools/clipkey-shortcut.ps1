$ErrorActionPreference = 'Stop'
$ClipKeyVersion = '1.1.0'
$trayScript = Join-Path $PSScriptRoot 'clipkey-tray.ps1'
$linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClipKey 트레이.lnk'
if (-not (Test-Path $trayScript)) {
    Write-Host "$trayScript 가 없습니다. 앱의 'PC 필수 스크립트'에서 트레이를 먼저 저장하세요." -ForegroundColor Red
    exit 1
}
$powershell = (Get-Command powershell.exe).Source
$arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $trayScript
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = $powershell
$link.Arguments = $arguments
$link.WorkingDirectory = $PSScriptRoot
$link.WindowStyle = 7
$link.IconLocation = "$env:SystemRoot\System32\input.dll,1"
$link.Save()
Start-Process $powershell -ArgumentList $arguments -WindowStyle Hidden
Write-Host "바탕 화면에 'ClipKey 트레이' 아이콘을 만들고 트레이를 띄웠습니다." -ForegroundColor Green
