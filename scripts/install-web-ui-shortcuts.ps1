param(
    [string]$WorkspaceRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$openScriptPath = Join-Path $PSScriptRoot 'open-web-ui.ps1'
$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
$keepPhoneReadyScriptPath = Join-Path $PSScriptRoot 'keep-web-ui-phone-ready.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not (Test-Path -Path $openScriptPath)) {
    throw "Missing script: $openScriptPath"
}
if (-not (Test-Path -Path $ensureScriptPath)) {
    throw "Missing script: $ensureScriptPath"
}
if (-not (Test-Path -Path $keepPhoneReadyScriptPath)) {
    throw "Missing script: $keepPhoneReadyScriptPath"
}

$shellPath = (Get-Command 'powershell.exe' -ErrorAction Stop).Source

function Resolve-NormalizedPath {
    param(
        [string]$PathText
    )

    if (-not $PathText -or -not $PathText.Trim()) {
        return ''
    }

    return [IO.Path]::GetFullPath($PathText.Trim())
}

function Test-PathInsideRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ParentPath,
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath
    )

    $normalizedParent = (Resolve-NormalizedPath -PathText $ParentPath).TrimEnd('\')
    $normalizedCandidate = (Resolve-NormalizedPath -PathText $CandidatePath).TrimEnd('\')
    if (-not $normalizedParent -or -not $normalizedCandidate) {
        return $false
    }

    $parentLower = $normalizedParent.ToLowerInvariant()
    $candidateLower = $normalizedCandidate.ToLowerInvariant()
    return (
        $candidateLower -eq $parentLower -or
        $candidateLower.StartsWith($parentLower + '\')
    )
}

function Resolve-ShortcutWorkspaceRoot {
    $explicitRoot = Resolve-NormalizedPath -PathText $WorkspaceRoot
    if ($explicitRoot) {
        return $explicitRoot
    }

    $envRoot = Resolve-NormalizedPath -PathText $env:WORKSPACE_AGENT_HUB_WORKSPACE_ROOT
    if ($envRoot) {
        return $envRoot
    }

    $packageRootPath = $repoRoot.Path
    if (Test-PathInsideRoot -ParentPath ([IO.Path]::GetTempPath()) -CandidatePath $packageRootPath) {
        throw "Workspace root must be provided explicitly when installing Workspace Agent Hub shortcuts from a temporary checkout ($packageRootPath). Pass -WorkspaceRoot or set WORKSPACE_AGENT_HUB_WORKSPACE_ROOT."
    }

    return (Split-Path -Parent $packageRootPath)
}

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
$resolvedWorkspaceRoot = Resolve-ShortcutWorkspaceRoot
$workspaceRootArgument = "-WorkspaceRoot `"$resolvedWorkspaceRoot`""

$legacyShortcutPaths = @(
    (Join-Path $desktopPath 'AI Agent Sessions.lnk'),
    (Join-Path $programsPath 'AI Agent Sessions.lnk')
)

$shortcutDefinitions = @(
    @{
        Path = Join-Path $desktopPath 'Workspace Agent Hub.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScriptPath`" $workspaceRootArgument"
        Description = 'Open Workspace Agent Hub in your browser'
        WindowStyle = 7
    },
    @{
        Path = Join-Path $programsPath 'Workspace Agent Hub.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScriptPath`" $workspaceRootArgument"
        Description = 'Open Workspace Agent Hub in your browser'
        WindowStyle = 7
    },
    @{
        Path = Join-Path $startupPath 'Workspace Agent Hub Background.lnk'
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepPhoneReadyScriptPath`" $workspaceRootArgument"
        Description = 'Keep Workspace Agent Hub phone-ready in the background after sign-in and self-heal if it stops'
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
