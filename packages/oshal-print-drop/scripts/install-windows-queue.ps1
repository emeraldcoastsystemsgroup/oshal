# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - installs the print-drop queue on a Windows client via directed IPP (Add-Printer -IppURL), the path proven to bind the Microsoft IPP Class Driver. Handles the two live-debugged failure modes: phantom WSD-staged twins of the device (same UUID) make Add-Printer report "The specified printer already exists" - they are removed first and the install retried; and the server's own WSD announcements re-stage the phantom mid-install, so the server should be running with --no-wsd while this script runs (restart it normally afterwards - the announced WSD device then merges into the installed queue's identity instead of colliding). Run elevated.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix a live-observed false success: Add-Printer via CIM writes a NON-terminating error that ignores $ErrorActionPreference, so the try block sailed past the failure and the script reported "Installed" with an empty queue. -ErrorAction Stop is now explicit on Add-Printer and the success path re-verifies the queue actually exists before claiming victory. If Windows keeps refusing with "already exists" on a state-poisoned client (no packets even sent - verified live), a REBOOT of the client resets the device-management services holding the stale identity.
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
        Add-Printer -Name $Name -IppURL $url -ErrorAction Stop
        $null = Get-Printer -Name $Name -ErrorAction Stop
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
    Write-Error "Install failed after 3 attempts. Checks: server reachable at $url and running with --no-wsd; and if the error is 'already exists' with no traffic reaching the server, REBOOT this client - its device-management services hold a stale identity for the printer."
}
