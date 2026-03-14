Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$workspaceRoot = Split-Path -Parent $repoRoot
$launcherScript = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$suiteId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$primaryLabel = "matrix-pc-$suiteId"
$secondaryLabel = "matrix-pc-alt-$suiteId"
$primarySessionName = "shell-$primaryLabel"
$secondarySessionName = "shell-$secondaryLabel"
$primaryTitle = 'Matrix PC Primary'
$secondaryTitle = 'Matrix PC Secondary'

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
    $jsonText = & $launcherScript -Mode list -Json
    if ($LASTEXITCODE -ne 0) {
        throw 'agent-session-launcher list failed.'
    }

    return @(ConvertFrom-LauncherJsonArray -JsonText (($jsonText | Out-String)))
}

function Assert-SessionVisible {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedTitle,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedFolder
    )

    $session = @(Get-LauncherSessions) | Where-Object { [string]$_.Name -eq $TargetSessionName } | Select-Object -First 1
    if (-not $session) {
        throw "Expected session '$TargetSessionName' to be visible in the launcher inventory."
    }

    if ([string]$session.DisplayTitle -ne $ExpectedTitle) {
        throw "Expected title '$ExpectedTitle' for '$TargetSessionName', got '$([string]$session.DisplayTitle)'."
    }

    if ([string]$session.WorkingDirectoryWindows -ne $ExpectedFolder) {
        throw "Expected folder '$ExpectedFolder' for '$TargetSessionName', got '$([string]$session.WorkingDirectoryWindows)'."
    }

    if (-not [bool]$session.IsLive) {
        throw "Expected '$TargetSessionName' to be live."
    }
}

function Assert-ResumeAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    $resumeOutput = & $launcherScript -Mode resume -SessionName $TargetSessionName -Detach
    if ($LASTEXITCODE -ne 0) {
        throw "Resume availability check failed for '$TargetSessionName'."
    }

    $resumeText = ($resumeOutput | Out-String).Trim()
    if ($resumeText -notmatch [regex]::Escape("Session '$TargetSessionName' is available")) {
        throw "Unexpected resume output for '$TargetSessionName': $resumeText"
    }
}

try {
    & $launcherScript -Mode new -Type shell -Name $primaryLabel -Title $primaryTitle -WorkingDirectory $workspaceRoot -Detach | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create the primary PC path-matrix session.'
    }

    Assert-SessionVisible -TargetSessionName $primarySessionName -ExpectedTitle $primaryTitle -ExpectedFolder $workspaceRoot
    Assert-ResumeAvailable -TargetSessionName $primarySessionName

    & $launcherScript -Mode new -Type shell -Name $secondaryLabel -Title $secondaryTitle -WorkingDirectory $repoRoot -Detach | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create the secondary PC path-matrix session.'
    }

    Assert-SessionVisible -TargetSessionName $secondarySessionName -ExpectedTitle $secondaryTitle -ExpectedFolder $repoRoot
    Assert-ResumeAvailable -TargetSessionName $secondarySessionName

    $sessions = @(Get-LauncherSessions) | Where-Object { [string]$_.Name -in @($primarySessionName, $secondarySessionName) }
    if ($sessions.Count -ne 2) {
        throw 'Expected both primary path-matrix sessions to appear together in the launcher inventory.'
    }

    Write-Output 'PASS'
} finally {
    foreach ($sessionName in @($primarySessionName, $secondarySessionName)) {
        try {
            & $launcherScript -Mode delete -SessionName $sessionName | Out-Null
        } catch {
        }
    }
}
