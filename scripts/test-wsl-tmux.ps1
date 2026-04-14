Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'
$codexAuthSyncScriptPath = Join-Path $PSScriptRoot 'sync-codex-auth.ps1'
$socketName = 'workspace-agent-hub-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$sessionLabel = 'isolated-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$sessionName = "shell-$sessionLabel"
$sessionLiveRootPath = if (
    $env:AI_AGENT_SESSION_LIVE_DIR_PATH -and
    $env:AI_AGENT_SESSION_LIVE_DIR_PATH.Trim()
) {
    [IO.Path]::GetFullPath($env:AI_AGENT_SESSION_LIVE_DIR_PATH.Trim())
} else {
    Join-Path $env:USERPROFILE 'agent-handoff\session-live'
}
$liveTranscriptPath = Join-Path $sessionLiveRootPath ($sessionName + '.log')
$liveEventPath = Join-Path $sessionLiveRootPath ($sessionName + '.event')

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

function Invoke-TmuxScript {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $scriptParameters = ConvertTo-ScriptParameters -Arguments $Arguments
    try {
        $output = & $tmuxScriptPath @scriptParameters 2>&1
    } catch {
        $detail = (($_ | Out-String).Trim())
        throw "wsl-tmux.ps1 failed. Args: $($Arguments -join ' ') $detail"
    }

    if ($LASTEXITCODE -ne 0) {
        throw "wsl-tmux.ps1 failed. Args: $($Arguments -join ' ')"
    }

    return @($output | ForEach-Object { [string]$_ })
}

function Invoke-TmuxJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $text = ((Invoke-TmuxScript -Arguments $Arguments) | Out-String).Trim()
    if (-not $text) {
        return @()
    }

    $parsed = $text | ConvertFrom-Json
    if ($parsed -is [System.Array]) {
        return @($parsed)
    }
    if ($null -eq $parsed) {
        return @()
    }

    return @($parsed)
}

function Invoke-SyncCodexAuthJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $scriptParameters = ConvertTo-ScriptParameters -Arguments $Arguments
    try {
        $text = (& $codexAuthSyncScriptPath @scriptParameters 2>&1 | Out-String).Trim()
    } catch {
        $detail = (($_ | Out-String).Trim())
        throw "sync-codex-auth.ps1 failed. Args: $($Arguments -join ' ') $detail"
    }

    if ($LASTEXITCODE -ne 0) {
        throw "sync-codex-auth.ps1 failed. Args: $($Arguments -join ' ')"
    }

    return ($text | ConvertFrom-Json)
}

function Get-WslHomeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $homeOutput = @(& wsl.exe -d $Distro -- bash -lc 'printf ''%s\n'' "$HOME"')
    if ($LASTEXITCODE -ne 0) {
        throw "Expected to resolve the WSL home directory for distro '$Distro'."
    }

    $homePath = (($homeOutput | Out-String).Trim()).TrimEnd('/')
    if (-not $homePath) {
        throw "Expected the WSL home directory for distro '$Distro' to be non-empty."
    }

    return $homePath
}

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    $normalizedPath = $WindowsPath -replace '\\', '/'
    $result = @(& wsl.exe -d Ubuntu -- wslpath -a -u $normalizedPath)
    if ($LASTEXITCODE -ne 0) {
        throw "Expected to convert '$WindowsPath' to a WSL path."
    }

    return (($result | Out-String).Trim())
}

function Get-LivePipeCommands {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    $commands = @(
        & wsl.exe -d Ubuntu -- env "TARGET_SESSION_NAME=$TargetSessionName" bash -lc 'ps -eo args | grep -F "$TARGET_SESSION_NAME.log" | grep -F "wsl-session-live-pipe" | grep -v grep || true'
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Expected to inspect live-pipe helper processes for '$TargetSessionName'."
    }

    return @($commands | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
}

try {
    if (Test-Path -Path $liveTranscriptPath) {
        [IO.File]::Delete($liveTranscriptPath)
    }
    if (Test-Path -Path $liveEventPath) {
        [IO.File]::Delete($liveEventPath)
    }

    $initialSessions = @(Invoke-TmuxJson -Arguments @(
        '-Action', 'list',
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-Json'
    ))
    if ($initialSessions.Count -ne 0) {
        throw 'Expected a fresh tmux socket to list zero sessions.'
    }

    $existsBeforeEnsure = ((Invoke-TmuxScript -Arguments @(
        '-Action', 'exists',
        '-SessionName', $sessionName,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName
    )) | Out-String).Trim()
    if ($existsBeforeEnsure -ne 'false') {
        throw "Expected exists to report false before ensure. Got: $existsBeforeEnsure"
    }

    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'ensure',
        '-SessionType', 'shell',
        '-SessionLabel', $sessionLabel,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-Detach'
    ))

    $afterEnsure = @(Invoke-TmuxJson -Arguments @(
        '-Action', 'list',
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-Json'
    ))
    if ($afterEnsure.Count -ne 1) {
        throw 'Expected the isolated tmux socket to contain one session after ensure.'
    }
    if ([string]$afterEnsure[0].Name -ne $sessionName) {
        throw "Expected the isolated tmux socket to contain '$sessionName'."
    }
    if (-not (Test-Path -Path $liveTranscriptPath)) {
        throw 'Expected ensure to provision the authoritative transcript log file.'
    }

    $existsAfterEnsure = ((Invoke-TmuxScript -Arguments @(
        '-Action', 'exists',
        '-SessionName', $sessionName,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName
    )) | Out-String).Trim()
    if ($existsAfterEnsure -ne 'true') {
        throw "Expected exists to report true after ensure. Got: $existsAfterEnsure"
    }

    [void](@(& wsl.exe -d Ubuntu -- bash -lc "tmux -L '$socketName' send-keys -t '$sessionName' -l 'echo live-bridge-pass' && tmux -L '$socketName' send-keys -t '$sessionName' Enter"))
    if ($LASTEXITCODE -ne 0) {
        throw 'Expected to send output into the isolated tmux session.'
    }
    Start-Sleep -Milliseconds 700
    $liveTranscript = if (Test-Path -Path $liveTranscriptPath) {
        Get-Content -Path $liveTranscriptPath -Raw -Encoding utf8
    } else {
        ''
    }
    if ($liveTranscript -notmatch 'live-bridge-pass') {
        throw "Expected the authoritative transcript log to capture tmux pane output. Got: $liveTranscript"
    }

    $livePipeCommands = @(Get-LivePipeCommands -TargetSessionName $sessionName)
    if ($livePipeCommands.Count -eq 0) {
        throw 'Expected an active session-live pipe helper process after ensure.'
    }
    $scriptsDirectoryWslPath = Convert-WindowsPathToWslPath -WindowsPath $PSScriptRoot
    $livePipeText = ($livePipeCommands | Out-String)
    if ($livePipeText -match [regex]::Escape($scriptsDirectoryWslPath)) {
        throw "Expected session-live helper processes to use a stable helper path outside the worktree scripts directory. Got: $livePipeText"
    }

    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'kill',
        '-SessionName', $sessionName,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName
    ))

    $startupCommand = 'printf ''%s\n'' "$HOME/.local/bin/codex"'
    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'ensure',
        '-SessionType', 'shell',
        '-SessionLabel', $sessionLabel,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-StartupCommand', $startupCommand,
        '-Detach'
    ))

    Start-Sleep -Milliseconds 700
    $paneOutput = @(& wsl.exe -d Ubuntu -- bash -lc "tmux -L '$socketName' capture-pane -pt '$sessionName' -S -40")
    if ($LASTEXITCODE -ne 0) {
        throw 'Expected to capture the isolated tmux pane after startup-command test.'
    }
    $paneText = ($paneOutput | Out-String)
    $wslHomeDirectory = Get-WslHomeDirectory -Distro 'Ubuntu'
    $expectedCodexPath = [regex]::Escape("$wslHomeDirectory/.local/bin/codex")
    if ($paneText -notmatch $expectedCodexPath) {
        throw "Expected startup command output to contain '$wslHomeDirectory/.local/bin/codex'. Output: $paneText"
    }
    if ($paneText -match 'C:Users|C:\\Users') {
        throw "Startup command leaked a Windows-style home path into tmux. Output: $paneText"
    }

    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'attach-hidden',
        '-SessionName', $sessionName,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-WindowWidth', '120',
        '-WindowHeight', '40'
    ))

    Start-Sleep -Milliseconds 1200
    $attachedCount = @(& wsl.exe -d Ubuntu -- bash -lc "tmux -L '$socketName' display-message -p -t '$sessionName' '#{session_attached}'")
    if ($LASTEXITCODE -ne 0) {
        throw 'Expected to query tmux attached-client count after attach-hidden.'
    }
    if ([int]($attachedCount | Select-Object -Last 1) -lt 1) {
        throw "Expected attach-hidden to create at least one attached tmux client. Got: $($attachedCount | Out-String)"
    }

    $windowSize = @(& wsl.exe -d Ubuntu -- bash -lc "tmux -L '$socketName' display-message -p -t '$sessionName' '#{window_width}x#{window_height}'")
    if ($LASTEXITCODE -ne 0) {
        throw 'Expected to query tmux window size after attach-hidden.'
    }
    if (($windowSize | Select-Object -Last 1) -ne '120x40') {
        throw "Expected attach-hidden to pin tmux size to 120x40. Got: $($windowSize | Out-String)"
    }

    $sourceAuthPath = Join-Path $env:TEMP ("workspace-agent-hub-codex-auth-source-" + [guid]::NewGuid().ToString('N') + '.json')
    $targetAuthPath = "/tmp/workspace-agent-hub-codex-auth-target-$([guid]::NewGuid().ToString('N')).json"
    Set-Content -Path $sourceAuthPath -Value '{"refresh_token":"fresh-token"}' -NoNewline -Encoding utf8

    try {
        $firstSync = Invoke-SyncCodexAuthJson -Arguments @(
            '-Distro', 'Ubuntu',
            '-SourcePath', $sourceAuthPath,
            '-TargetPath', $targetAuthPath,
            '-Json'
        )
        if (-not [bool]$firstSync.Synced -or [string]$firstSync.Reason -ne 'copied') {
            throw "Expected first Codex auth sync to copy the source file. Got: $($firstSync | ConvertTo-Json -Depth 4)"
        }

        $firstTargetContent = @(& wsl.exe -d Ubuntu -- bash -lc "cat '$targetAuthPath'")
        if ($LASTEXITCODE -ne 0) {
            throw 'Expected to read the synchronized Codex auth file from WSL.'
        }
        if ((($firstTargetContent | Out-String).Trim()) -ne '{"refresh_token":"fresh-token"}') {
            throw "Expected synchronized Codex auth file to match the Windows source content. Got: $($firstTargetContent | Out-String)"
        }

        $secondSync = Invoke-SyncCodexAuthJson -Arguments @(
            '-Distro', 'Ubuntu',
            '-SourcePath', $sourceAuthPath,
            '-TargetPath', $targetAuthPath,
            '-Json'
        )
        if ([bool]$secondSync.Synced -or [string]$secondSync.Reason -ne 'up-to-date') {
            throw "Expected second Codex auth sync to detect the file as up to date. Got: $($secondSync | ConvertTo-Json -Depth 4)"
        }
    } finally {
        if (Test-Path -Path $sourceAuthPath) {
            [IO.File]::Delete($sourceAuthPath)
        }
        [void](& wsl.exe -d Ubuntu -- bash -lc "rm -f '$targetAuthPath'")
    }

    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'kill',
        '-SessionName', $sessionName,
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName
    ))

    $afterKill = @(Invoke-TmuxJson -Arguments @(
        '-Action', 'list',
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-Json'
    ))
    if ($afterKill.Count -ne 0) {
        throw 'Expected the isolated tmux socket to be empty after kill.'
    }

    [void](Invoke-TmuxScript -Arguments @(
        '-Action', 'kill-server',
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName
    ))

    [void](& wsl.exe -d Ubuntu -- bash -lc "tmux -L '$socketName' list-sessions >/dev/null 2>&1")
    if ($LASTEXITCODE -eq 0) {
        throw 'Expected kill-server to remove the isolated tmux server entirely.'
    }

    Write-Output 'PASS'
} finally {
    if (Test-Path -Path $liveTranscriptPath) {
        [IO.File]::Delete($liveTranscriptPath)
    }
    if (Test-Path -Path $liveEventPath) {
        [IO.File]::Delete($liveEventPath)
    }
    try {
        [void](Invoke-TmuxScript -Arguments @(
            '-Action', 'kill',
            '-SessionName', $sessionName,
            '-Distro', 'Ubuntu',
            '-SocketName', $socketName
        ))
    } catch {
    }
}
