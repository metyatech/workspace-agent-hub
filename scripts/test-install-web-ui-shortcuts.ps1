Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'install-web-ui-shortcuts.ps1'
$expectedWorkspaceRoot = Split-Path -Parent ((Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wah-shortcuts-" + [Guid]::NewGuid().ToString('N'))
$desktopPath = Join-Path $tempRoot 'Desktop'
$programsPath = Join-Path $tempRoot 'Programs'
$startupPath = Join-Path $tempRoot 'Startup'

[System.IO.Directory]::CreateDirectory($desktopPath) | Out-Null
[System.IO.Directory]::CreateDirectory($programsPath) | Out-Null
[System.IO.Directory]::CreateDirectory($startupPath) | Out-Null

$desktopLegacyPath = Join-Path $desktopPath 'AI Agent Sessions.lnk'
$programsLegacyPath = Join-Path $programsPath 'AI Agent Sessions.lnk'
[System.IO.File]::WriteAllBytes($desktopLegacyPath, [byte[]](1, 2, 3))
[System.IO.File]::WriteAllBytes($programsLegacyPath, [byte[]](1, 2, 3))

$previousDesktopPath = $env:WORKSPACE_AGENT_HUB_SHORTCUTS_DESKTOP_PATH
$previousProgramsPath = $env:WORKSPACE_AGENT_HUB_SHORTCUTS_PROGRAMS_PATH
$previousStartupPath = $env:WORKSPACE_AGENT_HUB_SHORTCUTS_STARTUP_PATH

try {
    $env:WORKSPACE_AGENT_HUB_SHORTCUTS_DESKTOP_PATH = $desktopPath
    $env:WORKSPACE_AGENT_HUB_SHORTCUTS_PROGRAMS_PATH = $programsPath
    $env:WORKSPACE_AGENT_HUB_SHORTCUTS_STARTUP_PATH = $startupPath

    & $scriptPath -WorkspaceRoot $expectedWorkspaceRoot | Out-Null

    $expectedShortcuts = @(
        (Join-Path $desktopPath 'Workspace Agent Hub.lnk'),
        (Join-Path $programsPath 'Workspace Agent Hub.lnk'),
        (Join-Path $startupPath 'Workspace Agent Hub Background.lnk')
    )

    foreach ($shortcutPath in $expectedShortcuts) {
        if (-not (Test-Path -Path $shortcutPath)) {
            throw "Expected shortcut to exist: $shortcutPath"
        }
    }

    $shell = New-Object -ComObject WScript.Shell
    $desktopShortcut = $shell.CreateShortcut((Join-Path $desktopPath 'Workspace Agent Hub.lnk'))
    if ([string]$desktopShortcut.Arguments -notmatch '(?i)-WorkspaceRoot') {
        throw 'Expected the Desktop shortcut to persist the workspace root.'
    }
    if ([string]$desktopShortcut.Arguments -notmatch [regex]::Escape($expectedWorkspaceRoot)) {
        throw "Expected the Desktop shortcut to point at workspace root $expectedWorkspaceRoot."
    }
    $backgroundShortcut = $shell.CreateShortcut((Join-Path $startupPath 'Workspace Agent Hub Background.lnk'))
    if ([string]$backgroundShortcut.Arguments -notmatch '(?i)keep-web-ui-phone-ready\.ps1') {
        throw 'Expected the Startup shortcut to launch the phone-ready watchdog.'
    }
    if ([string]$backgroundShortcut.Arguments -notmatch '(?i)-WorkspaceRoot') {
        throw 'Expected the Startup shortcut to persist the workspace root.'
    }
    if ([string]$backgroundShortcut.Arguments -notmatch [regex]::Escape($expectedWorkspaceRoot)) {
        throw "Expected the Startup shortcut to point at workspace root $expectedWorkspaceRoot."
    }

    foreach ($legacyPath in @($desktopLegacyPath, $programsLegacyPath)) {
        if (Test-Path -Path $legacyPath) {
            throw "Expected legacy shortcut to be removed: $legacyPath"
        }
    }
} finally {
    foreach ($entry in @(
            @{ Name = 'WORKSPACE_AGENT_HUB_SHORTCUTS_DESKTOP_PATH'; Value = $previousDesktopPath },
            @{ Name = 'WORKSPACE_AGENT_HUB_SHORTCUTS_PROGRAMS_PATH'; Value = $previousProgramsPath },
            @{ Name = 'WORKSPACE_AGENT_HUB_SHORTCUTS_STARTUP_PATH'; Value = $previousStartupPath }
        )) {
        if ($null -eq $entry.Value) {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, 'Process')
        }
    }

    if ([System.IO.Directory]::Exists($tempRoot)) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}

Write-Output 'PASS'
