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

$desktopPath = [Environment]::GetFolderPath('Desktop')
$programsPath = [Environment]::GetFolderPath('Programs')
$startupPath = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell

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
        Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ensureScriptPath`""
        Description = 'Keep Workspace Agent Hub running in the background after sign-in'
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
