Set-StrictMode -Version Latest

function Get-PowerShellPathForCleanup {
    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command 'powershell.exe' -ErrorAction Stop).Source
}

function ConvertTo-ProcessCleanupArgumentString {
    param(
        [string[]]$ArgumentList = @()
    )

    $quoted = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if (-not $value.Length) {
            '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $value
            continue
        }

        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }

    return ($quoted -join ' ')
}

function Start-ParentProcessWatchdog {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$ChildProcess,
        [int]$ParentPid = $PID,
        [string]$WatchdogScriptPath = (Join-Path $PSScriptRoot 'process-watchdog.ps1')
    )

    if (-not (Test-Path -LiteralPath $WatchdogScriptPath)) {
        throw "Missing process watchdog script: $WatchdogScriptPath"
    }

    if ($ChildProcess.HasExited) {
        return $null
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Get-PowerShellPathForCleanup
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $WatchdogScriptPath,
        '-ParentPid',
        [string]$ParentPid,
        '-ChildPid',
        [string]$ChildProcess.Id
    )
    if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $argumentList) {
            [void]$startInfo.ArgumentList.Add([string]$argument)
        }
    } else {
        $startInfo.Arguments = ConvertTo-ProcessCleanupArgumentString -ArgumentList $argumentList
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    return $process
}

function Stop-ManagedProcessTree {
    param(
        [System.Diagnostics.Process]$Process
    )

    if ($null -eq $Process) {
        return
    }

    try {
        if ($Process.HasExited) {
            return
        }
    } catch {
        return
    }

    try {
        $Process.Kill($true)
    } catch {
        try {
            & taskkill /PID $Process.Id /T /F | Out-Null
        } catch {
        }
    }

    try {
        $Process.WaitForExit()
    } catch {
    }
}

function Stop-ManagedWatchdogProcess {
    param(
        [System.Diagnostics.Process]$Process
    )

    if ($null -eq $Process) {
        return
    }

    try {
        if (-not $Process.HasExited -and -not $Process.WaitForExit(2000)) {
            Stop-ManagedProcessTree -Process $Process
        }
    } catch {
        Stop-ManagedProcessTree -Process $Process
    }

    try {
        $Process.Dispose()
    } catch {
    }
}
