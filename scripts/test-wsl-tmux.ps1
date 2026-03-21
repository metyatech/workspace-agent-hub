Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'
$codexAuthSyncScriptPath = Join-Path $PSScriptRoot 'sync-codex-auth.ps1'
$socketName = 'workspace-agent-hub-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$sessionLabel = 'isolated-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$sessionName = "shell-$sessionLabel"

function Invoke-TmuxScript {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmuxScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "wsl-tmux.ps1 failed. Args: $($Arguments -join ' ')"
    }

    return @($output)
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

    $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexAuthSyncScriptPath @Arguments | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "sync-codex-auth.ps1 failed. Args: $($Arguments -join ' ')"
    }

    return ($text | ConvertFrom-Json)
}

try {
    $initialSessions = @(Invoke-TmuxJson -Arguments @(
        '-Action', 'list',
        '-Distro', 'Ubuntu',
        '-SocketName', $socketName,
        '-Json'
    ))
    if ($initialSessions.Count -ne 0) {
        throw 'Expected a fresh tmux socket to list zero sessions.'
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
    if ($paneText -notmatch '/home/[^/\s]+/\.local/bin/codex') {
        throw "Expected startup command output to contain the WSL home path for codex. Output: $paneText"
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

    Write-Output 'PASS'
} finally {
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
