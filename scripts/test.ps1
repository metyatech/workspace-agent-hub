Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$testStateRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-test-state-' + [guid]::NewGuid().ToString('N'))
$testSessionCatalogPath = Join-Path $testStateRoot 'session-catalog.json'
$testSessionLiveDirPath = Join-Path $testStateRoot 'session-live'
$testTmuxSocketName = 'workspace-agent-hub-suite-' + [guid]::NewGuid().ToString('N').Substring(0, 12)

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

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

function Get-PowerShellPath {
    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command 'powershell.exe' -ErrorAction Stop).Source
}

function Get-NpmCommandPath {
    return (Get-Command 'npm.cmd' -ErrorAction Stop).Source
}

function ConvertTo-QuotedArgumentString {
    param(
        [string[]]$ArgumentList = @()
    )

    $quoted = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if (-not $value.Length) {
            '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $value
            continue
        }

        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }

    return ($quoted -join ' ')
}

function New-TestIsolationState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $rootPath = Join-Path $testStateRoot $Label
    $catalogPath = Join-Path $rootPath 'session-catalog.json'
    $liveDirPath = Join-Path $rootPath 'session-live'
    [System.IO.Directory]::CreateDirectory($liveDirPath) | Out-Null
    Set-Content -Path $catalogPath -Value '[]' -Encoding utf8
    return [pscustomobject]@{
        CatalogPath = $catalogPath
        LiveDirPath = $liveDirPath
        TmuxSocketName = 'workspace-agent-hub-' + $Label + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    }
}

function Start-TestLaneProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$EnvironmentOverrides = @{},
        [string]$WorkingDirectory = $repoRoot
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
        $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
    }
    if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $ArgumentList) {
            [void]$startInfo.ArgumentList.Add([string]$argument)
        }
    } else {
        $startInfo.Arguments = ConvertTo-QuotedArgumentString -ArgumentList $ArgumentList
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()

    return [pscustomobject]@{
        Name = $Name
        Process = $process
        StdOutTask = $process.StandardOutput.ReadToEndAsync()
        StdErrTask = $process.StandardError.ReadToEndAsync()
    }
}

function Wait-TestLaneProcess {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo
    )

    $ProcessInfo.Process.WaitForExit()
    $stdoutText = $ProcessInfo.StdOutTask.GetAwaiter().GetResult()
    $stderrText = $ProcessInfo.StdErrTask.GetAwaiter().GetResult()
    if ($ProcessInfo.Process.ExitCode -eq 0) {
        return
    }

    $detail = if ($stderrText.Trim()) { $stderrText.Trim() } elseif ($stdoutText.Trim()) { $stdoutText.Trim() } else { '' }
    if ($detail) {
        throw "$($ProcessInfo.Name) failed. $detail"
    }

    throw "$($ProcessInfo.Name) failed with exit code $($ProcessInfo.Process.ExitCode)."
}

function Wait-TestLaneProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$ProcessInfos
    )

    Wait-Process -Id (@($ProcessInfos | ForEach-Object { $_.Process.Id }))
    foreach ($processInfo in $ProcessInfos) {
        Wait-TestLaneProcess -ProcessInfo $processInfo
    }
}

function Stop-TestLaneProcesses {
    param(
        [object[]]$ProcessInfos = @()
    )

    foreach ($processInfo in @($ProcessInfos)) {
        try {
            if ($processInfo.Process -and -not $processInfo.Process.HasExited) {
                $processInfo.Process.Kill()
                $processInfo.Process.WaitForExit()
            }
        } catch {
        }

        if ($processInfo.Process) {
            $processInfo.Process.Dispose()
        }
    }
}

function Stop-TestTmuxSocketServers {
    param(
        [string[]]$SocketNames = @()
    )

    $resolvedSockets = @(
        $SocketNames |
            Where-Object { $_ -and $_.Trim() } |
            ForEach-Object { $_.Trim() } |
            Select-Object -Unique
    )
    if ($resolvedSockets.Count -eq 0) {
        return
    }

    $tmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'
    foreach ($socketName in $resolvedSockets) {
        try {
            [void](& $tmuxScriptPath -Action kill-server -Distro 'Ubuntu' -SocketName $socketName)
        } catch {
        }
    }
}

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }
} finally {
    Pop-Location
}

[System.IO.Directory]::CreateDirectory($testStateRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($testSessionLiveDirPath) | Out-Null
Set-Content -Path $testSessionCatalogPath -Value '[]' -Encoding utf8

$previousSessionCatalogPath = $env:AI_AGENT_SESSION_CATALOG_PATH
$previousSessionLiveDirPath = $env:AI_AGENT_SESSION_LIVE_DIR_PATH
$previousTmuxSocketName = $env:AI_AGENT_SESSION_TMUX_SOCKET_NAME

$env:AI_AGENT_SESSION_CATALOG_PATH = $testSessionCatalogPath
$env:AI_AGENT_SESSION_LIVE_DIR_PATH = $testSessionLiveDirPath
$env:AI_AGENT_SESSION_TMUX_SOCKET_NAME = $testTmuxSocketName

try {
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

    $laneProcesses = @()
    $laneIsolationSockets = @()
    try {
        $wslFoundationIsolation = New-TestIsolationState -Label 'wsl-foundation'
        $mobilePrimaryIsolation = New-TestIsolationState -Label 'mobile-primary'
        $sessionBridgeIsolation = New-TestIsolationState -Label 'session-bridge'
        $npmUnitIsolation = New-TestIsolationState -Label 'npm-unit'
        $npmE2eIsolation = New-TestIsolationState -Label 'npm-e2e'
        $laneIsolationSockets = @(
            $wslFoundationIsolation.TmuxSocketName,
            $mobilePrimaryIsolation.TmuxSocketName,
            $sessionBridgeIsolation.TmuxSocketName,
            $npmUnitIsolation.TmuxSocketName,
            $npmE2eIsolation.TmuxSocketName
        )
        $laneProcesses = @(
            (Start-TestLaneProcess `
                -Name 'wsl-foundation-lane' `
                -FilePath (Get-PowerShellPath) `
                -ArgumentList @(
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    (Join-Path $PSScriptRoot 'test-wsl-foundation-lane.ps1')
                ) `
                -EnvironmentOverrides @{
                    AI_AGENT_SESSION_CATALOG_PATH = $wslFoundationIsolation.CatalogPath
                    AI_AGENT_SESSION_LIVE_DIR_PATH = $wslFoundationIsolation.LiveDirPath
                    AI_AGENT_SESSION_TMUX_SOCKET_NAME = $wslFoundationIsolation.TmuxSocketName
                }),
            (Start-TestLaneProcess `
                -Name 'mobile-primary-lane' `
                -FilePath (Get-PowerShellPath) `
                -ArgumentList @(
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    (Join-Path $PSScriptRoot 'test-mobile-primary-lane.ps1')
                ) `
                -EnvironmentOverrides @{
                    AI_AGENT_SESSION_CATALOG_PATH = $mobilePrimaryIsolation.CatalogPath
                    AI_AGENT_SESSION_LIVE_DIR_PATH = $mobilePrimaryIsolation.LiveDirPath
                    AI_AGENT_SESSION_TMUX_SOCKET_NAME = $mobilePrimaryIsolation.TmuxSocketName
                }),
            (Start-TestLaneProcess `
                -Name 'session-bridge-lane' `
                -FilePath (Get-PowerShellPath) `
                -ArgumentList @(
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    (Join-Path $PSScriptRoot 'test-session-bridge-lane.ps1')
                ) `
                -EnvironmentOverrides @{
                    AI_AGENT_SESSION_CATALOG_PATH = $sessionBridgeIsolation.CatalogPath
                    AI_AGENT_SESSION_LIVE_DIR_PATH = $sessionBridgeIsolation.LiveDirPath
                    AI_AGENT_SESSION_TMUX_SOCKET_NAME = $sessionBridgeIsolation.TmuxSocketName
                }),
            (Start-TestLaneProcess `
                -Name 'npm-unit-lane' `
                -FilePath (Get-NpmCommandPath) `
                -ArgumentList @('run', 'test:unit') `
                -EnvironmentOverrides @{
                    AI_AGENT_SESSION_CATALOG_PATH = $npmUnitIsolation.CatalogPath
                    AI_AGENT_SESSION_LIVE_DIR_PATH = $npmUnitIsolation.LiveDirPath
                    AI_AGENT_SESSION_TMUX_SOCKET_NAME = $npmUnitIsolation.TmuxSocketName
                }),
            (Start-TestLaneProcess `
                -Name 'npm-e2e-lane' `
                -FilePath (Get-NpmCommandPath) `
                -ArgumentList @('run', 'test:e2e') `
                -EnvironmentOverrides @{
                    AI_AGENT_SESSION_CATALOG_PATH = $npmE2eIsolation.CatalogPath
                    AI_AGENT_SESSION_LIVE_DIR_PATH = $npmE2eIsolation.LiveDirPath
                    AI_AGENT_SESSION_TMUX_SOCKET_NAME = $npmE2eIsolation.TmuxSocketName
                })
        )
        Wait-TestLaneProcesses -ProcessInfos $laneProcesses
    } finally {
        Stop-TestLaneProcesses -ProcessInfos $laneProcesses
        Stop-TestTmuxSocketServers -SocketNames $laneIsolationSockets
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

$npmBootstrapOutput = & (Join-Path $PSScriptRoot 'test-npm-bootstrap.ps1')
if (($npmBootstrapOutput | Out-String).Trim() -notmatch 'PASS') {
    Write-Error 'Expected the npm dependency bootstrap probe to reject partial node_modules surfaces and accept a complete install surface.'
    exit 1
}

    $postProcesses = @()
    try {
        $postProcesses = @(
            (Start-TestLaneProcess -Name 'cli-json-output' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-cli-json-output.ps1'))),
            (Start-TestLaneProcess -Name 'wrapper-failure' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-start-web-ui-wrapper-failure.ps1'))),
            (Start-TestLaneProcess -Name 'shortcut-install' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-install-web-ui-shortcuts.ps1'))),
            (Start-TestLaneProcess -Name 'phone-ready-watchdog' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-keep-web-ui-phone-ready.ps1'))),
            (Start-TestLaneProcess -Name 'ensure-build-detection' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-ensure-web-ui-build-detection.ps1'))),
            (Start-TestLaneProcess -Name 'session-catalog-retry' -FilePath (Get-PowerShellPath) -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-session-catalog-retry.ps1')))
        )
        Wait-TestLaneProcesses -ProcessInfos $postProcesses
    } finally {
        Stop-TestLaneProcesses -ProcessInfos $postProcesses
    }

    $wrapperJsonOutput = & (Join-Path $PSScriptRoot 'test-start-web-ui-wrapper.ps1')
    if (($wrapperJsonOutput | Out-String).Trim() -notmatch 'OK') {
        Write-Error 'Expected the PowerShell start-web-ui wrapper to launch and emit machine-readable web-ui metadata.'
        exit 1
    }

    $ensureSwapOutput = & (Join-Path $PSScriptRoot 'test-ensure-web-ui-running-swap.ps1')
    if (($ensureSwapOutput | Out-String).Trim() -notmatch 'PASS') {
        Write-Error 'Expected ensure-web-ui-running.ps1 to keep the previous listener available until the replacement instance is ready.'
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
} finally {
    Stop-TestTmuxSocketServers -SocketNames @(
        $testTmuxSocketName
    )
    foreach ($entry in @(
            @{ Name = 'AI_AGENT_SESSION_CATALOG_PATH'; Value = $previousSessionCatalogPath },
            @{ Name = 'AI_AGENT_SESSION_LIVE_DIR_PATH'; Value = $previousSessionLiveDirPath },
            @{ Name = 'AI_AGENT_SESSION_TMUX_SOCKET_NAME'; Value = $previousTmuxSocketName }
        )) {
        if ($null -eq $entry.Value) {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, 'Process')
        }
    }

    if (Test-Path -Path $testStateRoot) {
        [System.IO.Directory]::Delete($testStateRoot, $true)
    }
}

Write-Output 'Tests OK.'
