Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$workspaceRoot = Split-Path -Parent $repoRoot
$launcherScript = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$sessionLabel = "manage-verify-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$sessionName = "shell-$sessionLabel"
$initialTitle = 'Management Verify Initial'
$renamedTitle = 'Management Verify Renamed'

function ConvertFrom-LauncherJsonArray {
    param(
        [Parameter(Mandatory = $true)]
        [string]$JsonText
    )

    $trimmed = $JsonText.Trim()
    if (-not $trimmed) {
        return @()
    }

    $parsed = $trimmed | ConvertFrom-Json
    if ($parsed -is [System.Array]) {
        return @($parsed)
    }
    return @($parsed)
}

function Get-LauncherSessions {
    param(
        [switch]$IncludeArchived
    )

    if ($IncludeArchived) {
        $jsonText = & $launcherScript -Mode list -Json -IncludeArchived
    } else {
        $jsonText = & $launcherScript -Mode list -Json
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'agent-session-launcher list failed.'
    }

    return @(ConvertFrom-LauncherJsonArray -JsonText (($jsonText | Out-String)))
}

try {
    & $launcherScript -Mode new -Type shell -Name $sessionLabel -Title $initialTitle -WorkingDirectory $workspaceRoot -Detach | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create management verification session.'
    }

    $visibleSessions = @(Get-LauncherSessions)
    $visibleSession = $visibleSessions | Where-Object { [string]$_.Name -eq $sessionName } | Select-Object -First 1
    if (-not $visibleSession) {
        throw 'Expected the newly created session to be visible before archiving.'
    }
    if ([string]$visibleSession.DisplayTitle -ne $initialTitle) {
        throw "Expected initial title '$initialTitle', got '$([string]$visibleSession.DisplayTitle)'."
    }

    & $launcherScript -Mode rename -SessionName $sessionName -Title $renamedTitle | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to rename the session.'
    }

    $renamedSession = @(Get-LauncherSessions) | Where-Object { [string]$_.Name -eq $sessionName } | Select-Object -First 1
    if (-not $renamedSession -or [string]$renamedSession.DisplayTitle -ne $renamedTitle) {
        throw 'Expected the renamed title to appear in the visible session list.'
    }

    & $launcherScript -Mode archive -SessionName $sessionName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to archive the session.'
    }

    $visibleAfterArchive = @(@(Get-LauncherSessions) | Where-Object { [string]$_.Name -eq $sessionName })
    if ($visibleAfterArchive.Count -ne 0) {
        throw 'Archived sessions should be hidden from the default list.'
    }

    $archivedSession = @(Get-LauncherSessions -IncludeArchived) | Where-Object { [string]$_.Name -eq $sessionName } | Select-Object -First 1
    if (-not $archivedSession) {
        throw 'Archived session should still exist in the archived-inclusive inventory.'
    }
    if (-not [bool]$archivedSession.Archived -or -not [bool]$archivedSession.IsLive) {
        throw 'Archived running session should remain live and marked archived.'
    }

    & $launcherScript -Mode close -SessionName $sessionName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to close the session.'
    }

    $closedSession = @(Get-LauncherSessions -IncludeArchived) | Where-Object { [string]$_.Name -eq $sessionName } | Select-Object -First 1
    if (-not $closedSession) {
        throw 'Closed session should still exist in the archived-inclusive inventory.'
    }
    if ([bool]$closedSession.IsLive) {
        throw 'Closed session should no longer be live.'
    }
    if ([string]$closedSession.State -notmatch '^Closed') {
        throw "Expected a closed state label, got '$([string]$closedSession.State)'."
    }

    & $launcherScript -Mode delete -SessionName $sessionName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to delete the session.'
    }

    $deletedSession = @(@(Get-LauncherSessions -IncludeArchived) | Where-Object { [string]$_.Name -eq $sessionName })
    if ($deletedSession.Count -ne 0) {
        throw 'Deleted session should disappear from the archived-inclusive inventory.'
    }

    Write-Output 'PASS'
} finally {
    try {
        & $launcherScript -Mode delete -SessionName $sessionName | Out-Null
    } catch {
    }
}
