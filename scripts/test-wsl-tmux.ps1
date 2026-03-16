Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'
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
