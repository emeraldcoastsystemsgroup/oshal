# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - installs the print-drop queue on a Windows client via directed IPP (Add-Printer -IppURL), the path proven to bind the Microsoft IPP Class Driver. Handles the two live-debugged failure modes: phantom WSD-staged twins of the device (same UUID) make Add-Printer report "The specified printer already exists" - they are removed first and the install retried; and the server's own WSD announcements re-stage the phantom mid-install, so the server should be running with --no-wsd while this script runs (restart it normally afterwards - the announced WSD device then merges into the installed queue's identity instead of colliding). Run elevated.
#
# Usage (elevated PowerShell, on the client that should print):
#   .\install-windows-queue.ps1 -PrinterHost <server-ip> [-Name "Oshal Print to File Printer"] [-Port 631]
param(
    [Parameter(Mandatory = $true)] [string] $PrinterHost,
    [string] $Name = 'Oshal Print to File Printer',
    [int] $Port = 631
)

$ErrorActionPreference = 'Stop'
$url = "http://${PrinterHost}:${Port}/ipp/print"
Write-Host "Installing '$Name' from $url"

$installed = $false
for ($attempt = 1; $attempt -le 3 -and -not $installed; $attempt++) {
    # Phantom WSD-staged twins of this device block the IPP install with
    # "printer already exists" - clear them each attempt.
    Get-PnpDevice -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -like "*$Name*" -or ($_.InstanceId -like 'SWD\DAFWSDPROVIDER*' -and $_.Class -in @('SoftwareDevice', 'WSDPrintDevice') -and $_.FriendlyName -like '*Oshal*') } |
        ForEach-Object {
            Write-Host "  removing staged device: $($_.InstanceId)"
            & pnputil /remove-device "$($_.InstanceId)" | Out-Null
        }
    try { Remove-Printer -Name $Name -ErrorAction Stop; Write-Host '  removed stale queue' } catch {}
    try {
        Add-Printer -Name $Name -IppURL $url
        $installed = $true
    } catch {
        Write-Host "  attempt ${attempt}: $($_.Exception.Message)"
        if ($_.Exception.Message -match 'already exists') {
            Write-Host '  (if this repeats: make sure the server is running with --no-wsd during install)'
        }
        Start-Sleep -Seconds 2
    }
}

if ($installed) {
    $p = Get-Printer -Name $Name
    Write-Host "Installed. Driver: $($p.DriverName)  Port: $($p.PortName)  Status: $($p.PrinterStatus)"
    Write-Host 'Print a test page; the document lands in the drop folder on the server host.'
} else {
    Write-Error "Install failed after 3 attempts. Is the server reachable at $url and running with --no-wsd?"
}
