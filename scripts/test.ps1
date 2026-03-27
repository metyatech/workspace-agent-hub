Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$nodeModulesPath = Join-Path $repoRoot 'node_modules'

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

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-Path -Path $nodeModulesPath))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }
} finally {
    Pop-Location
}

$bootstrapScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'wsl-mobile-login-bootstrap.sh')
$startMenuScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-start.sh')
$manageMenuScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-manage.sh')
$catalogPathScript = Convert-WindowsPathToWslPath -WindowsPath (Join-Path $PSScriptRoot 'test-wsl-mobile-menu-catalog-path.sh')

@(
    @{
        Probe = 'tmux -V'
        Description = 'tmux'
        InstallHint = 'Install tmux inside the Ubuntu WSL distro before running verify.'
    },
    @{
        Probe = 'node --version'
        Description = 'Node.js'
        InstallHint = 'Run sudo ./scripts/install-wsl-node.sh inside the repository WSL path before running verify.'
    }
) | ForEach-Object {
    $probeOutput = & wsl.exe -d Ubuntu -- bash -lc $_.Probe
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Expected $($_.Description) to be installed inside the Ubuntu WSL distro. $($_.InstallHint)"
        exit 1
    }
}

$probeViaWslEnv = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 SSH_CONNECTION=test-via-wsl bash -lc "$bootstrapScript --probe"
if (($probeViaWslEnv | Out-String).Trim() -ne 'open-menu') {
    Write-Error 'Expected mobile menu probe to open when SSH_CONNECTION is present in WSL.'
    exit 1
}

$probeViaWindowsEnv = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 AI_AGENT_MOBILE_WINDOWS_SSH_CONNECTION=test-via-windows bash -lc "$bootstrapScript --probe"

if (($probeViaWindowsEnv | Out-String).Trim() -ne 'open-menu') {
    Write-Error 'Expected mobile menu probe to open when SSH_CONNECTION is available only through the Windows-side fallback bridge.'
    exit 1
}

$probeBypassed = wsl.exe -d Ubuntu -- env AI_AGENT_MOBILE_ASSUME_TTY=1 AI_AGENT_MOBILE_BYPASS=1 SSH_CONNECTION=test-bypass bash -lc "$bootstrapScript --probe"
if (($probeBypassed | Out-String).Trim() -ne 'skip-menu') {
    Write-Error 'Expected mobile menu probe to skip when AI_AGENT_MOBILE_BYPASS is set.'
    exit 1
}

$startMenuOutput = wsl.exe -d Ubuntu -- bash -lc $startMenuScript
if (($startMenuOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected start-menu flow to create a session with the requested title and directory.'
    exit 1
}

$manageMenuOutput = wsl.exe -d Ubuntu -- bash -lc $manageMenuScript
if (($manageMenuOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected mobile session management commands to rename, archive, close, and delete sessions.'
    exit 1
}

$catalogPathOutput = wsl.exe -d Ubuntu -- bash -lc $catalogPathScript
if (($catalogPathOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the mobile menu to fall back cleanly when Windows USERPROFILE is unavailable and to honor AI_AGENT_SESSION_CATALOG_PATH overrides.'
    exit 1
}

$wslTmuxOutput = & (Join-Path $PSScriptRoot 'test-wsl-tmux.ps1')
if (($wslTmuxOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected wsl-tmux to list an empty isolated socket cleanly and to create, list, and kill sessions without relying on a pre-existing tmux server.'
    exit 1
}

$primaryPathMatrixOutput = & (Join-Path $PSScriptRoot 'test-primary-path-matrix.ps1')
if (($primaryPathMatrixOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the PC-side primary path matrix verification to pass for start, inventory, and resume availability.'
    exit 1
}

$mobileSshOutput = python (Join-Path $PSScriptRoot 'test-mobile-ssh.py')
if (($mobileSshOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the SSH -> WSL mobile menu path to pass the mobile primary path matrix verification.'
    exit 1
}

$runAndroidMobileE2E = ($env:WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E -eq '1')
if ($runAndroidMobileE2E) {
    $androidE2eScript = Join-Path $PSScriptRoot 'test-android-mobile-e2e.py'
    $androidProbeOutput = python $androidE2eScript --probe
    if (($androidProbeOutput | Out-String).Trim() -eq 'available') {
        $androidE2eOutput = python $androidE2eScript
        if (($androidE2eOutput | Out-String).Trim() -notmatch 'PASS') {
            Write-Error 'Expected the Android emulator mobile E2E to connect through ConnectBot and resume the prepared tmux session.'
            exit 1
        }
    } else {
        Write-Output "Skipping Android emulator mobile E2E. $($androidProbeOutput | Out-String | ForEach-Object { $_.Trim() })"
    }
} else {
    Write-Output 'Skipping Android emulator mobile E2E. Set WORKSPACE_AGENT_HUB_RUN_ANDROID_MOBILE_E2E=1 to run the emulator-backed ConnectBot check.'
}

$sessionManagementOutput = & (Join-Path $PSScriptRoot 'test-session-management.ps1')
if (($sessionManagementOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the launcher session management commands to rename, archive, close, and delete sessions.'
    exit 1
}

$webSessionBridgeOutput = & (Join-Path $PSScriptRoot 'test-web-session-bridge.ps1')
if (($webSessionBridgeOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the web-session bridge to start, send to, capture, interrupt, close, and delete a shell session.'
    exit 1
}

Push-Location $repoRoot
try {
    if (Test-Path -Path $packageJsonPath) {
        npm run test
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run test failed.'
        }
    }
} finally {
    Pop-Location
}

$cliJsonOutput = & (Join-Path $PSScriptRoot 'test-cli-json-output.ps1')
if (($cliJsonOutput | Out-String).Trim() -notmatch 'OK') {
    Write-Error 'Expected the built CLI to emit machine-readable web-ui launch metadata through --json.'
    exit 1
}

$wrapperJsonOutput = & (Join-Path $PSScriptRoot 'test-start-web-ui-wrapper.ps1')
if (($wrapperJsonOutput | Out-String).Trim() -notmatch 'OK') {
    Write-Error 'Expected the PowerShell start-web-ui wrapper to launch and emit machine-readable web-ui metadata.'
    exit 1
}

$wrapperFailureOutput = & (Join-Path $PSScriptRoot 'test-start-web-ui-wrapper-failure.ps1')
if (($wrapperFailureOutput | Out-String).Trim() -notmatch 'OK') {
    Write-Error 'Expected the PowerShell start-web-ui wrapper to preserve child stderr and report a concrete exit code on failure.'
    exit 1
}

$shortcutInstallOutput = & (Join-Path $PSScriptRoot 'test-install-web-ui-shortcuts.ps1')
if (($shortcutInstallOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the shortcut installer to create Workspace Agent Hub shortcuts and remove stale AI Agent Sessions shortcuts.'
    exit 1
}

$ensureSwapOutput = & (Join-Path $PSScriptRoot 'test-ensure-web-ui-running-swap.ps1')
if (($ensureSwapOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected ensure-web-ui-running.ps1 to keep the previous listener available until the replacement instance is ready.'
    exit 1
}

$phoneReadyWatchdogOutput = & (Join-Path $PSScriptRoot 'test-keep-web-ui-phone-ready.ps1')
if (($phoneReadyWatchdogOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the phone-ready watchdog to rerun ensure-web-ui-running.ps1 and reject duplicate instances cleanly.'
    exit 1
}

$tls12 = [Net.SecurityProtocolType]::Tls12
if (-not ([Net.ServicePointManager]::SecurityProtocol.HasFlag($tls12))) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $tls12
}

$urls = @(
    'https://github.com/metyatech/workspace-agent-hub'
)

foreach ($url in $urls) {
    try {
        $response = Invoke-WebRequest `
            -Uri $url `
            -Method Get `
            -MaximumRedirection 5 `
            -TimeoutSec 20 `
            -Headers @{ 'User-Agent' = 'workspace-agent-hub-link-check' } `
            -UseBasicParsing `
            -ErrorAction Stop
    } catch {
        Write-Error "Link check failed for $url. $($_.Exception.Message)"
        exit 1
    }

    $statusCode = [int]$response.StatusCode
    if ($statusCode -lt 200 -or $statusCode -ge 400) {
        Write-Error "Link check returned status $statusCode for $url"
        exit 1
    }
}

Write-Output 'Tests OK.'
