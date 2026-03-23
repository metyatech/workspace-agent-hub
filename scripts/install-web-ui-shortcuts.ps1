Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$openScriptPath = Join-Path $PSScriptRoot 'open-web-ui.ps1'
$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
if (-not (Test-Path -Path $openScriptPath)) {
    throw "Missing script: $openScriptPath"
}
if (-not (Test-Path -Path $ensureScriptPath)) {
    throw "Missing script: $ensureScriptPath"
}

$shellPath = (Get-Command 'powershell.exe' -ErrorAction Stop).Source

function Get-ShortcutFolderPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvironmentVariableName,
        [Parameter(Mandatory = $true)]
        [string]$SpecialFolderName
    )

    $override = [Environment]::GetEnvironmentVariable($EnvironmentVariableName, 'Process')
    if ([string]::IsNullOrWhiteSpace($override)) {
        return [Environment]::GetFolderPath($SpecialFolderName)
    }

    return $override
}

$desktopPath = Get-ShortcutFolderPath -EnvironmentVariableName 'WORKSPACE_AGENT_HUB_SHORTCUTS_DESKTOP_PATH' -SpecialFolderName 'Desktop'
$programsPath = Get-ShortcutFolderPath -EnvironmentVariableName 'WORKSPACE_AGENT_HUB_SHORTCUTS_PROGRAMS_PATH' -SpecialFolderName 'Programs'
$startupPath = Get-ShortcutFolderPath -EnvironmentVariableName 'WORKSPACE_AGENT_HUB_SHORTCUTS_STARTUP_PATH' -SpecialFolderName 'Startup'
$shell = New-Object -ComObject WScript.Shell

$legacyShortcutPaths = @(
    (Join-Path $desktopPath 'AI Agent Sessions.lnk'),
    (Join-Path $programsPath 'AI Agent Sessions.lnk')
)

$shortcutDefinitions = @(
    @{
        Path = Join-Path $desktopPath 'Workspace Agent Hub.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScriptPath`""
        Description = 'Open Workspace Agent Hub in your browser'
        WindowStyle = 7
    },
    @{
        Path = Join-Path $programsPath 'Workspace Agent Hub.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScriptPath`""
        Description = 'Open Workspace Agent Hub in your browser'
        WindowStyle = 7
    },
    @{
        Path = Join-Path $startupPath 'Workspace Agent Hub Background.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ensureScriptPath`" -PhoneReady"
        Description = 'Keep Workspace Agent Hub phone-ready in the background after sign-in'
        WindowStyle = 7
    }
)

foreach ($definition in $shortcutDefinitions) {
    $shortcut = $shell.CreateShortcut($definition.Path)
    $shortcut.TargetPath = $shellPath
    $shortcut.Arguments = $definition.Arguments
    $shortcut.WorkingDirectory = Split-Path -Parent $openScriptPath
    $shortcut.IconLocation = "$shellPath,0"
    $shortcut.Description = $definition.Description
    $shortcut.WindowStyle = $definition.WindowStyle
    $shortcut.Save()
    Write-Output "Shortcut updated: $($definition.Path)"
}

foreach ($legacyPath in $legacyShortcutPaths) {
    if (Test-Path -Path $legacyPath) {
        Remove-Item -Path $legacyPath -Force
        Write-Output "Removed legacy shortcut: $legacyPath"
    }
}
