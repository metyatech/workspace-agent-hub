Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeScriptPath = Join-Path $PSScriptRoot 'session-web-bridge.ps1'
$sessionLabel = 'web-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedSessionName = "shell-$sessionLabel"

function Invoke-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Bridge command failed. Args: $($Arguments -join ' ')"
    }

    return ((($raw | Out-String).Trim()) | ConvertFrom-Json)
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
        & powershell -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -Action delete -SessionName $resolvedSessionName -Json | Out-Null
    } catch {
    }
}
