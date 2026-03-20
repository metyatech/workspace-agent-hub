Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
$powerShellPath = (Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue)?.Source
if (-not $powerShellPath) {
    $powerShellPath = (Get-Command 'powershell.exe' -ErrorAction Stop).Source
}

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([int]$listener.LocalEndpoint.Port)
    } finally {
        $listener.Stop()
    }
}

function Start-EnsureProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath,
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [Parameter(Mandatory = $true)]
        [string]$RunName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDirectory
    )

    $stdoutPath = Join-Path $TargetDirectory "$RunName.stdout.log"
    $stderrPath = Join-Path $TargetDirectory "$RunName.stderr.log"
    $process = Start-Process -FilePath $powerShellPath -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $ScriptPath,
        '-Port',
        [string]$PortNumber,
        '-StatePath',
        $TargetStatePath,
        '-AuthToken',
        $Token,
        '-JsonOutput'
    ) -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

    return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Wait-ForLaunchMetadata {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStdOutPath,
        [int]$TimeoutMilliseconds = 60000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Test-Path -Path $TargetStdOutPath) {
            try {
                $raw = Get-Content -Path $TargetStdOutPath -Raw -Encoding utf8
                if ($raw -and $raw.Trim()) {
                    return ($raw | ConvertFrom-Json)
                }
            } catch {
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected ensure-web-ui-running.ps1 to emit launch metadata in $TargetStdOutPath."
}

function Wait-ForProcessSuccess {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo,
        [int]$TimeoutSeconds = 30
    )

    if (-not $ProcessInfo.Process.WaitForExit($TimeoutSeconds * 1000)) {
        try {
            Stop-Process -Id $ProcessInfo.Process.Id -Force -ErrorAction Stop
        } catch {
        }
        throw "ensure-web-ui-running.ps1 did not exit within $TimeoutSeconds seconds."
    }

    if ($ProcessInfo.Process.ExitCode -eq 0) {
        return
    }

    $stderrText = if (Test-Path -Path $ProcessInfo.StdErrPath) {
        (Get-Content -Path $ProcessInfo.StdErrPath -Raw -Encoding utf8).Trim()
    } else {
        ''
    }
    $stdoutText = if (Test-Path -Path $ProcessInfo.StdOutPath) {
        (Get-Content -Path $ProcessInfo.StdOutPath -Raw -Encoding utf8).Trim()
    } else {
        ''
    }
    $detail = if ($stderrText) {
        $stderrText
    } elseif ($stdoutText) {
        $stdoutText
    } else {
        'No output captured.'
    }
    throw "ensure-web-ui-running.ps1 failed with exit code $($ProcessInfo.Process.ExitCode). $detail"
}

function Wait-ForApiReady {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [int]$TimeoutMilliseconds = 30000
    )

    $headers = @{ 'X-Workspace-Agent-Hub-Token' = $Token }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/api/sessions?includeArchived=true" -Headers $headers -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Expected the ensured web UI to answer API requests.'
}

$testDirectory = Join-Path $env:TEMP ('workspace-agent-hub-open-web-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testDirectory -Force)
$statePath = Join-Path $testDirectory 'state.json'
$port = Get-FreeTcpPort
$testPassed = $false
$originalTailscaleServeStatusText = $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT

try {
    $firstRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-test-token' -RunName 'first' -TargetDirectory $testDirectory
    $first = Wait-ForLaunchMetadata -TargetStdOutPath $firstRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $firstRun

    if (-not $first.ListenUrl) {
        throw 'Expected ensure-web-ui-running.ps1 to return a listen URL.'
    }
    if ([string]$first.AccessCode -ne 'ensure-test-token') {
        throw 'Expected ensure-web-ui-running.ps1 to preserve the requested auth token.'
    }

    $firstPort = ([Uri][string]$first.ListenUrl).Port
    Wait-ForApiReady -PortNumber $firstPort -Token 'ensure-test-token'

    $secondRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-test-token' -RunName 'second' -TargetDirectory $testDirectory
    $second = Wait-ForLaunchMetadata -TargetStdOutPath $secondRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $secondRun
    $secondPort = ([Uri][string]$second.ListenUrl).Port
    Wait-ForApiReady -PortNumber $secondPort -Token 'ensure-test-token'

    if ([string]$second.ListenUrl -ne [string]$first.ListenUrl) {
        throw 'Expected ensure-web-ui-running.ps1 to reuse the existing instance when it is already healthy.'
    }
    if ([string]$second.AccessCode -ne 'ensure-test-token') {
        throw 'Expected ensure-web-ui-running.ps1 to preserve the requested auth token on reuse.'
    }
    if ([int]$second.ProcessId -ne [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to reuse the same background process when the instance is already healthy.'
    }

    $tailscaleState = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    $tailscaleState.PreferredConnectUrlSource = 'tailscale-serve'
    $tailscaleState.PreferredConnectUrl = 'https://desktop-dr5v76c.tail5a2d2d.ts.net'
    ($tailscaleState | ConvertTo-Json -Depth 8) | Set-Content -Path $statePath -Encoding utf8
    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$firstPort
"@

    $serveHealthyRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-test-token' -RunName 'serve-healthy' -TargetDirectory $testDirectory
    $serveHealthy = Wait-ForLaunchMetadata -TargetStdOutPath $serveHealthyRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $serveHealthyRun
    $serveHealthyPort = ([Uri][string]$serveHealthy.ListenUrl).Port
    Wait-ForApiReady -PortNumber $serveHealthyPort -Token 'ensure-test-token'

    if ([int]$serveHealthy.ProcessId -ne [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to keep reusing the existing instance when the saved Tailscale Serve target still matches the listener port.'
    }

    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @'
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:57921
'@

    $serveMismatchRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-test-token' -RunName 'serve-mismatch' -TargetDirectory $testDirectory
    $serveMismatch = Wait-ForLaunchMetadata -TargetStdOutPath $serveMismatchRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $serveMismatchRun
    $serveMismatchPort = ([Uri][string]$serveMismatch.ListenUrl).Port
    Wait-ForApiReady -PortNumber $serveMismatchPort -Token 'ensure-test-token'

    if ([int]$serveMismatch.ProcessId -eq [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to restart when the saved Tailscale Serve target no longer matches the listener port.'
    }

    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$serveMismatchPort
"@

    $corruptedState = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    $corruptedState.ProcessId = 999999
    ($corruptedState | ConvertTo-Json -Depth 8) | Set-Content -Path $statePath -Encoding utf8

    $stalePidRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-test-token' -RunName 'stale-pid' -TargetDirectory $testDirectory
    $stalePid = Wait-ForLaunchMetadata -TargetStdOutPath $stalePidRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $stalePidRun
    Wait-ForApiReady -PortNumber ([Uri][string]$stalePid.ListenUrl).Port -Token 'ensure-test-token'

    if ([int]$stalePid.ProcessId -ne [int]$serveMismatch.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to recover the real listener PID when the saved wrapper PID is stale.'
    }

    $thirdRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-next-token' -RunName 'third' -TargetDirectory $testDirectory
    $third = Wait-ForLaunchMetadata -TargetStdOutPath $thirdRun.StdOutPath
    Wait-ForProcessSuccess -ProcessInfo $thirdRun
    Wait-ForApiReady -PortNumber ([Uri][string]$third.ListenUrl).Port -Token 'ensure-next-token'

    if ([string]$third.AccessCode -ne 'ensure-next-token') {
        throw 'Expected ensure-web-ui-running.ps1 to restart with the newly requested auth token when the existing instance token differs.'
    }
    if ([int]$third.ProcessId -eq [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to start a new background process when the auth token changes.'
    }

    $testPassed = $true
} finally {
    if (Test-Path -Path $statePath) {
        $state = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($state.ProcessId) {
            try {
                Stop-Process -Id ([int]$state.ProcessId) -Force -ErrorAction Stop
            } catch {
            }
            try {
                Wait-Process -Id ([int]$state.ProcessId) -Timeout 5 -ErrorAction Stop
            } catch {
            }
        }
    }

    if ($null -eq $originalTailscaleServeStatusText) {
        Remove-Item Env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT -ErrorAction SilentlyContinue
    } else {
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = $originalTailscaleServeStatusText
    }

    if (Test-Path -Path $testDirectory) {
        Start-Sleep -Milliseconds 200
        try {
            [IO.Directory]::Delete($testDirectory, $true)
        } catch {
        }
    }
}

if ($testPassed) {
    Write-Output 'Ensure web UI startup OK.'
}
