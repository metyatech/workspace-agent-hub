Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    $normalizedPath = $WindowsPath -replace '\\', '/'
    $output = & wsl.exe -d Ubuntu -- wslpath -a -u $normalizedPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to convert Windows path to WSL path: $WindowsPath"
    }

    return (($output | Out-String).Trim())
}

$bootstrapScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'wsl-mobile-login-bootstrap.sh')
$startMenuScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-start.sh')
$manageMenuScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-manage.sh')
$catalogPathScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-catalog-path.sh')

$probeViaWslEnv = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 SSH_CONNECTION=test-via-wsl bash -lc "$bootstrapScript --probe"
if (($probeViaWslEnv | Out-String).Trim() -ne 'open-menu') {
    throw 'Expected mobile menu probe to open when SSH_CONNECTION is present in WSL.'
}

$probeViaWindowsEnv = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 AI_AGENT_MOBILE_WINDOWS_SSH_CONNECTION=test-via-windows bash -lc "$bootstrapScript --probe"
if (($probeViaWindowsEnv | Out-String).Trim() -ne 'open-menu') {
    throw 'Expected mobile menu probe to open when SSH_CONNECTION is available only through the Windows-side fallback bridge.'
}

$probeBypassed = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 AI_AGENT_MOBILE_BYPASS=1 SSH_CONNECTION=test-bypass bash -lc "$bootstrapScript --probe"
if (($probeBypassed | Out-String).Trim() -ne 'skip-menu') {
    throw 'Expected mobile menu probe to skip when AI_AGENT_MOBILE_BYPASS is set.'
}

$startMenuOutput = wsl.exe -d Ubuntu -- bash -lc $startMenuScript
if (($startMenuOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected start-menu flow to create a session with the requested title and directory.'
}

$manageMenuOutput = wsl.exe -d Ubuntu -- bash -lc $manageMenuScript
if (($manageMenuOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected mobile session management commands to rename, archive, close, and delete sessions.'
}

$catalogPathOutput = wsl.exe -d Ubuntu -- bash -lc $catalogPathScript
if (($catalogPathOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the mobile menu to fall back cleanly when Windows USERPROFILE is unavailable and to honor AI_AGENT_SESSION_CATALOG_PATH overrides.'
}

$wslTmuxOutput = & (Join-Path $PSScriptRoot 'test-wsl-tmux.ps1')
if (($wslTmuxOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected wsl-tmux to list an empty isolated socket cleanly and to create, list, and kill sessions without relying on a pre-existing tmux server.'
}

Write-Output 'PASS'
