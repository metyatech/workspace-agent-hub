Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeScriptPath = Join-Path $PSScriptRoot 'session-web-bridge.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$workspaceRoot = Split-Path -Parent $repoRoot
$sessionLabel = 'web-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedSessionName = "shell-$sessionLabel"
$codexSessionLabel = 'web-codex-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedCodexSessionName = "codex-$codexSessionLabel"
$sessionLiveRootPath = if (
    $env:AI_AGENT_SESSION_LIVE_DIR_PATH -and
    $env:AI_AGENT_SESSION_LIVE_DIR_PATH.Trim()
) {
    [IO.Path]::GetFullPath($env:AI_AGENT_SESSION_LIVE_DIR_PATH.Trim())
} else {
    Join-Path $env:USERPROFILE 'agent-handoff\session-live'
}
$shellEventPath = Join-Path $sessionLiveRootPath ($resolvedSessionName + '.event')
$shellTranscriptPath = Join-Path $sessionLiveRootPath ($resolvedSessionName + '.log')

function ConvertTo-ScriptParameters {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $scriptParameters = @{}
    $index = 0
    while ($index -lt $Arguments.Count) {
        $token = [string]$Arguments[$index]
        if (-not $token.StartsWith('-')) {
            throw "Expected named script argument token. Got '$token'."
        }

        $parameterName = $token.TrimStart('-')
        $nextIsValue =
            ($index + 1) -lt $Arguments.Count -and
            -not (([string]$Arguments[$index + 1]).StartsWith('-'))
        if ($nextIsValue) {
            $scriptParameters[$parameterName] = [string]$Arguments[$index + 1]
            $index += 2
            continue
        }

        $scriptParameters[$parameterName] = $true
        $index += 1
    }

    return $scriptParameters
}

function Invoke-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $scriptParameters = ConvertTo-ScriptParameters -Arguments $Arguments
    try {
        $captured = & $bridgeScriptPath @scriptParameters 2>&1
    } catch {
        $detail = (($_ | Out-String).Trim())
        throw "Bridge command failed. Args: $($Arguments -join ' ') $detail"
    }

    if ($LASTEXITCODE -ne 0) {
        $detail = (($captured | Out-String).Trim())
        if (-not $detail) {
            $detail = "Exit code $LASTEXITCODE."
        }
        throw "Bridge command failed. Args: $($Arguments -join ' ') $detail"
    }

    return (((($captured | ForEach-Object { [string]$_ }) | Out-String).Trim()) | ConvertFrom-Json)
}

function New-Utf8PayloadFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Prefix
    )

    $tempPath = Join-Path $env:TEMP ("workspace-agent-hub-$Prefix-" + [guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($tempPath, $Value, [System.Text.UTF8Encoding]::new($false))
    return $tempPath
}

$titlePayloadPath = ''
$codexAuthSourcePath = ''
$codexAuthTargetPath = ''
$previousCodexAuthSource = $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE
$previousCodexAuthTarget = $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET
$previousCodexStartupCommand = $env:WORKSPACE_AGENT_HUB_CODEX_STARTUP_COMMAND
$utf8Title = [string]::Concat([char]0x30C6, [char]0x30B9, [char]0x30C8)

try {
    if (Test-Path -Path $shellEventPath) {
        [IO.File]::Delete($shellEventPath)
    }
    if (Test-Path -Path $shellTranscriptPath) {
        [IO.File]::Delete($shellTranscriptPath)
    }

    $titlePayloadPath = New-Utf8PayloadFile -Value $utf8Title -Prefix 'title'
    $started = Invoke-BridgeJson -Arguments @(
        '-Action', 'start',
        '-Type', 'shell',
        '-SessionName', $sessionLabel,
        '-TitlePath', $titlePayloadPath,
        '-WorkingDirectory', $workspaceRoot,
        '-Json'
    )

    if ([string]$started.Name -ne $resolvedSessionName) {
        throw "Unexpected session name. Expected '$resolvedSessionName', got '$($started.Name)'."
    }
    if ([string]$started.DisplayTitle -ne $utf8Title) {
        throw "Expected the started shell session title to preserve UTF-8 text. Got '$([string]$started.DisplayTitle)'."
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
    if ([string]$listed[0].DisplayTitle -ne $utf8Title) {
        throw "Expected the listed shell session title to preserve UTF-8 text. Got '$([string]$listed[0].DisplayTitle)'."
    }
    if (-not [bool]$listed[0].IsLive) {
        throw 'Expected the newly started shell session to be live in the web-session inventory.'
    }
    $eventBeforeSend = if (Test-Path -Path $shellEventPath) {
        Get-Content -Path $shellEventPath -Raw -Encoding utf8
    } else {
        ''
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'send',
        '-SessionName', $resolvedSessionName,
        '-Text', 'echo web-ui-bridge-pass',
        '-Submit',
        '-Json'
    ))

    Start-Sleep -Milliseconds 200
    if (-not (Test-Path -Path $shellEventPath)) {
        throw 'Expected send to update the authoritative session event stamp.'
    }
    $eventAfterSend = Get-Content -Path $shellEventPath -Raw -Encoding utf8
    if ($eventAfterSend -eq $eventBeforeSend) {
        throw 'Expected send to refresh the authoritative session event stamp.'
    }

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
    if ((Get-Content -Path $shellTranscriptPath -Raw -Encoding utf8) -notmatch 'web-ui-bridge-pass') {
        throw 'Expected the authoritative shell transcript log to include the sent output.'
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

    $codexAuthSourcePath = New-Utf8PayloadFile -Value '{"refresh_token":"web-bridge-fresh-token"}' -Prefix 'codex-auth'
    $codexAuthTargetPath = "/tmp/workspace-agent-hub-web-bridge-codex-auth-$([guid]::NewGuid().ToString('N')).json"
    $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE = $codexAuthSourcePath
    $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET = $codexAuthTargetPath
    $env:WORKSPACE_AGENT_HUB_CODEX_STARTUP_COMMAND = 'printf ''codex-web-sync-pass\n'''

    $startedCodex = Invoke-BridgeJson -Arguments @(
        '-Action', 'start',
        '-Type', 'codex',
        '-SessionName', $codexSessionLabel,
        '-Title', 'Codex Web Sync',
        '-WorkingDirectory', $workspaceRoot,
        '-Json'
    )

    if ([string]$startedCodex.Name -ne $resolvedCodexSessionName) {
        throw "Unexpected codex session name. Expected '$resolvedCodexSessionName', got '$($startedCodex.Name)'."
    }

    Start-Sleep -Milliseconds 1200

    $codexOutput = Invoke-BridgeJson -Arguments @(
        '-Action', 'output',
        '-SessionName', $resolvedCodexSessionName,
        '-Lines', '80',
        '-Json'
    )

    if ([string]$codexOutput.Transcript -notmatch 'codex-web-sync-pass') {
        throw 'Expected the codex web-session startup override to reach the transcript.'
    }

    $syncedAuthContent = @(& wsl.exe -d Ubuntu -- bash -lc "cat '$codexAuthTargetPath'")
    if ($LASTEXITCODE -ne 0) {
        throw 'Expected the codex auth sync target to exist in WSL after web-session start.'
    }
    if ((($syncedAuthContent | Out-String).Trim()) -ne '{"refresh_token":"web-bridge-fresh-token"}') {
        throw "Expected the codex auth sync target to match the Windows source file. Got: $($syncedAuthContent | Out-String)"
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'close',
        '-SessionName', $resolvedCodexSessionName,
        '-Json'
    ))

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'delete',
        '-SessionName', $resolvedCodexSessionName,
        '-Json'
    ))

    Write-Output 'PASS'
} finally {
    if ($null -eq $previousCodexAuthSource) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE', $null, 'Process')
    } else {
        $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE = $previousCodexAuthSource
    }
    if ($null -eq $previousCodexAuthTarget) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET', $null, 'Process')
    } else {
        $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET = $previousCodexAuthTarget
    }
    if ($null -eq $previousCodexStartupCommand) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_CODEX_STARTUP_COMMAND', $null, 'Process')
    } else {
        $env:WORKSPACE_AGENT_HUB_CODEX_STARTUP_COMMAND = $previousCodexStartupCommand
    }
    if ($titlePayloadPath -and (Test-Path -Path $titlePayloadPath)) {
        [IO.File]::Delete($titlePayloadPath)
    }
    if ($codexAuthSourcePath -and (Test-Path -Path $codexAuthSourcePath)) {
        [IO.File]::Delete($codexAuthSourcePath)
    }
    try {
        [void](& wsl.exe -d Ubuntu -- bash -lc "rm -f '$codexAuthTargetPath'")
    } catch {
    }
    try {
        [void](Invoke-BridgeJson -Arguments @('-Action', 'delete', '-SessionName', $resolvedSessionName, '-Json'))
    } catch {
    }
    try {
        [void](Invoke-BridgeJson -Arguments @('-Action', 'delete', '-SessionName', $resolvedCodexSessionName, '-Json'))
    } catch {
    }
    if (Test-Path -Path $shellEventPath) {
        [IO.File]::Delete($shellEventPath)
    }
    if (Test-Path -Path $shellTranscriptPath) {
        [IO.File]::Delete($shellTranscriptPath)
    }
}
