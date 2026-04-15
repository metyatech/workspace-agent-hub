param(
    [Parameter(Mandatory = $true)]
    [int]$ParentPid,
    [Parameter(Mandatory = $true)]
    [int]$ChildPid,
    [int]$PollIntervalMs = 250
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

while ($true) {
    $childProcess = Get-Process -Id $ChildPid -ErrorAction SilentlyContinue
    if ($null -eq $childProcess) {
        break
    }

    $parentProcess = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -eq $parentProcess) {
        try {
            & taskkill /PID $ChildPid /T /F | Out-Null
        } catch {
        }
        break
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}
