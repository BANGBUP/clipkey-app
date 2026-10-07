<#
.SYNOPSIS
  Lists - and with -Remove, unpairs - ClipKey Bluetooth pairings on this Windows PC,
  including ones the Settings app no longer shows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File clipkey-pairing.ps1           # list only
  powershell -ExecutionPolicy Bypass -File clipkey-pairing.ps1 -Remove   # unpair every ClipKey

.NOTES
  Use Windows PowerShell 5.1 ("powershell", not "pwsh"): it can call the Windows Runtime
  pairing API. Unpairing your own Bluetooth devices needs no administrator rights.
#>
param(
    [switch]$Remove,
    [string]$Name = 'ClipKey'
)
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -ne 'Desktop') {
    Write-Error 'Run this in Windows PowerShell 5.1 (powershell.exe), not PowerShell 7 (pwsh).'
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
[void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]

# WinRT async -> .NET Task, so PowerShell can wait for the result.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRt($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    $task.Result
}

$selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true)
$paired = Wait-WinRt ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) `
    ([Windows.Devices.Enumeration.DeviceInformationCollection])
$found = @($paired | Where-Object { $_.Name -like "*$Name*" })

if ($found.Count -eq 0) {
    Write-Host "No paired Bluetooth LE device named like '$Name' on this PC."
    Write-Host "($($paired.Count) paired Bluetooth LE device(s) in total.)"
    exit 0
}

$found | ForEach-Object {
    [pscustomobject]@{ Name = $_.Name; Paired = $_.Pairing.IsPaired; Id = $_.Id }
} | Format-Table -AutoSize

if (-not $Remove) {
    Write-Host 'Add -Remove to unpair the devices above.'
    exit 0
}

foreach ($device in $found) {
    $result = Wait-WinRt ($device.Pairing.UnpairAsync()) ([Windows.Devices.Enumeration.DeviceUnpairingResult])
    Write-Host ("{0}: {1}" -f $device.Name, $result.Status)
}
Write-Host 'Done. In the ClipKey app open "PC 블루투스 연결 추가", then add the device again in Windows.'
