Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'process-cleanup.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-process-watchdog-' + [guid]::NewGuid().ToString('N'))
$holdDir = Join-Path $tempRoot 'held-dir'
$childPidPath = Join-Path $tempRoot 'child.pid'
$parentScriptPath = Join-Path $tempRoot 'spawn-parent.ps1'

[System.IO.Directory]::CreateDirectory($holdDir) | Out-Null

$escapedHelperPath = (Join-Path $PSScriptRoot 'process-cleanup.ps1') -replace "'", "''"
$escapedHoldDir = $holdDir -replace "'", "''"
$escapedChildPidPath = $childPidPath -replace "'", "''"
$parentScript = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
. '$escapedHelperPath'
`$child = [System.Diagnostics.Process]::new()
`$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
`$startInfo.FileName = (Get-PowerShellPathForCleanup)
`$startInfo.UseShellExecute = `$false
`$startInfo.CreateNoWindow = `$true
`$startInfo.WorkingDirectory = '$escapedHoldDir'
if (`$startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
    [void]`$startInfo.ArgumentList.Add('-NoProfile')
    [void]`$startInfo.ArgumentList.Add('-Command')
    [void]`$startInfo.ArgumentList.Add('Set-Location -LiteralPath ''$escapedHoldDir''; Start-Sleep -Seconds 120')
} else {
    `$startInfo.Arguments = '-NoProfile -Command "Set-Location -LiteralPath ''$escapedHoldDir''; Start-Sleep -Seconds 120"'
}
`$child.StartInfo = `$startInfo
[void]`$child.Start()
`$watchdog = Start-ParentProcessWatchdog -ParentPid `$PID -ChildProcess `$child
[System.IO.File]::WriteAllText('$escapedChildPidPath', [string]`$child.Id, [Text.UTF8Encoding]::new(`$false))
"@
[System.IO.File]::WriteAllText($parentScriptPath, $parentScript, [Text.UTF8Encoding]::new($false))

$parentProcess = [System.Diagnostics.Process]::new()
$parentStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$parentStartInfo.FileName = Get-PowerShellPathForCleanup
$parentStartInfo.UseShellExecute = $false
$parentStartInfo.CreateNoWindow = $true
$parentStartInfo.WorkingDirectory = $tempRoot
if ($parentStartInfo.PSObject.Properties.Name -contains 'ArgumentList') {
    [void]$parentStartInfo.ArgumentList.Add('-NoProfile')
    [void]$parentStartInfo.ArgumentList.Add('-ExecutionPolicy')
    [void]$parentStartInfo.ArgumentList.Add('Bypass')
    [void]$parentStartInfo.ArgumentList.Add('-File')
    [void]$parentStartInfo.ArgumentList.Add($parentScriptPath)
} else {
    $parentStartInfo.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $parentScriptPath)
}
$parentProcess.StartInfo = $parentStartInfo

try {
    [void]$parentProcess.Start()
    $parentProcess.WaitForExit()
    if ($parentProcess.ExitCode -ne 0) {
        throw "Expected parent cleanup process to exit successfully, got $($parentProcess.ExitCode)."
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if (Test-Path -LiteralPath $childPidPath) {
            break
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not (Test-Path -LiteralPath $childPidPath)) {
        throw 'Expected the parent cleanup script to write the child PID.'
    }

    $childPid = [int]((Get-Content -LiteralPath $childPidPath -Raw).Trim())
    $childStopped = $false
    $removeSucceeded = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $childProcess = Get-Process -Id $childPid -ErrorAction SilentlyContinue
        $childStopped = ($null -eq $childProcess)
        if ($childStopped) {
            try {
                Remove-Item -LiteralPath $holdDir -Recurse -Force -ErrorAction Stop
                $removeSucceeded = $true
                break
            } catch {
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $childStopped) {
        throw "Expected child process $childPid to stop when the parent process exited."
    }
    if (-not $removeSucceeded) {
        throw 'Expected the held directory to become removable after the parent process exited.'
    }
} finally {
    Stop-ManagedProcessTree -Process $parentProcess
    $parentProcess.Dispose()
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'PASS'
