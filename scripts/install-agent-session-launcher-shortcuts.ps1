Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherPath = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
if (-not (Test-Path -Path $launcherPath)) {
    throw "Missing launcher script: $launcherPath"
}

$shortcutName = 'AI Agent Sessions.lnk'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$startMenuPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

$shortcutTargets = @(
    (Join-Path $desktopPath $shortcutName),
    (Join-Path $startMenuPrograms $shortcutName)
)

$shell = New-Object -ComObject WScript.Shell

foreach ($shortcutPath in $shortcutTargets) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    $shortcut.TargetPath = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell.exe).Source }
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`""
    $shortcut.WorkingDirectory = Split-Path -Parent $launcherPath
    $shortcut.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
    $shortcut.Description = 'Open the AI Agent Session Launcher'
    $shortcut.Save()
    Write-Output "Shortcut updated: $shortcutPath"
}
