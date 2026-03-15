Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeScriptPath = Join-Path $PSScriptRoot 'session-web-bridge.ps1'
$sessionLabel = 'web-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedSessionName = "shell-$sessionLabel"

function ConvertTo-QuotedArgumentString {
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

function Invoke-HiddenPowerShell {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $stdoutPath = Join-Path $env:TEMP ("workspace-agent-hub-test-stdout-" + [guid]::NewGuid().ToString('N') + '.log')
    $stderrPath = Join-Path $env:TEMP ("workspace-agent-hub-test-stderr-" + [guid]::NewGuid().ToString('N') + '.log')
    try {
        $process = Start-Process -FilePath 'powershell.exe' -ArgumentList (ConvertTo-QuotedArgumentString -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments)) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $stdoutText = if (Test-Path -Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw } else { '' }
        $stderrText = if (Test-Path -Path $stderrPath) { Get-Content -Path $stderrPath -Raw } else { '' }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $stdoutText
            StdErr = $stderrText
        }
    } finally {
        foreach ($pathValue in @($stdoutPath, $stderrPath)) {
            if (Test-Path -Path $pathValue) {
                [IO.File]::SetAttributes($pathValue, [IO.FileAttributes]::Normal)
                [IO.File]::Delete($pathValue)
            }
        }
    }
}

function Invoke-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-HiddenPowerShell -ScriptPath $bridgeScriptPath -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        $detail = if ($result.StdErr.Trim()) { $result.StdErr.Trim() } elseif ($result.StdOut.Trim()) { $result.StdOut.Trim() } else { "Exit code $($result.ExitCode)." }
        throw "Bridge command failed. Args: $($Arguments -join ' ') $detail"
    }

    return (($result.StdOut.Trim()) | ConvertFrom-Json)
}

try {
    $started = Invoke-BridgeJson -Arguments @(
        '-Action', 'start',
        '-Type', 'shell',
        '-SessionName', $sessionLabel,
        '-Title', 'Web Session Bridge Test',
        '-WorkingDirectory', 'D:\ghws',
        '-Json'
    )

    if ([string]$started.Name -ne $resolvedSessionName) {
        throw "Unexpected session name. Expected '$resolvedSessionName', got '$($started.Name)'."
    }
    if (-not [bool]$started.IsLive) {
        throw 'Expected started shell session to be live.'
    }

    $listedSessions = @(Invoke-BridgeJson -Arguments @(
        '-Action', 'list',
        '-IncludeArchived',
        '-Json'
    ))
    $listed = @($listedSessions | Where-Object { [string]$_.Name -eq $resolvedSessionName })
    if ($listed.Count -ne 1) {
        throw 'Expected the newly started shell session to appear exactly once in the web-session inventory.'
    }
    if (-not [bool]$listed[0].IsLive) {
        throw 'Expected the newly started shell session to be live in the web-session inventory.'
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'send',
        '-SessionName', $resolvedSessionName,
        '-Text', 'echo web-ui-bridge-pass',
        '-Submit',
        '-Json'
    ))

    Start-Sleep -Milliseconds 500

    $output = Invoke-BridgeJson -Arguments @(
        '-Action', 'output',
        '-SessionName', $resolvedSessionName,
        '-Lines', '80',
        '-Json'
    )

    if ([string]$output.Transcript -notmatch 'web-ui-bridge-pass') {
        throw 'Expected transcript to include the sent shell output.'
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'interrupt',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'close',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'delete',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    Write-Output 'PASS'
} finally {
    try {
        [void](Invoke-HiddenPowerShell -ScriptPath $bridgeScriptPath -Arguments @('-Action', 'delete', '-SessionName', $resolvedSessionName, '-Json'))
    } catch {
    }
}
