Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'keep-web-ui-phone-ready.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wah-phone-ready-" + [Guid]::NewGuid().ToString('N'))
$statePath = Join-Path $tempRoot 'state\hub.json'
$counterPath = Join-Path $tempRoot 'counter.txt'
$mockEnsurePath = Join-Path $tempRoot 'mock-ensure.ps1'

[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([int]$listener.LocalEndpoint.Port)
    } finally {
        $listener.Stop()
    }
}

function Start-MockManagerStatusServer {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [Parameter(Mandatory = $true)]
        [string]$StatusJson
    )

    $job = Start-Job -ArgumentList $PortNumber, $StatusJson -ScriptBlock {
        param(
            [int]$PortNumber,
            [string]$StatusJson
        )

        Add-Type -AssemblyName System.Net.HttpListener
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://127.0.0.1:$PortNumber/")
        $listener.Start()
        try {
            while ($true) {
                $context = $listener.GetContext()
                try {
                    if ($context.Request.Url.AbsolutePath -eq '/manager/api/manager/status') {
                        $body = [Text.Encoding]::UTF8.GetBytes($StatusJson)
                        $context.Response.StatusCode = 200
                        $context.Response.ContentType = 'application/json; charset=utf-8'
                        $context.Response.ContentLength64 = $body.Length
                        $context.Response.OutputStream.Write($body, 0, $body.Length)
                    } else {
                        $context.Response.StatusCode = 404
                    }
                } finally {
                    $context.Response.OutputStream.Close()
                    $context.Response.Close()
                }
            }
        } finally {
            $listener.Stop()
            $listener.Close()
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/manager/api/manager/status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $job
            }
        } catch {
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Expected the mock Manager status server to become ready.'
}

$mockEnsureContent = @'
param(
    [int]$Port = 3360,
    [string]$AuthToken = '',
    [string]$StatePath = '',
    [switch]$PhoneReady,
    [switch]$OpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$counterPath = [Environment]::GetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($counterPath)) {
    throw 'Missing WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH.'
}

$count = 0
if (Test-Path -Path $counterPath) {
    $count = [int]((Get-Content -Path $counterPath -Raw -Encoding utf8).Trim())
}
$count += 1
Set-Content -Path $counterPath -Value $count -Encoding utf8

if (-not $PhoneReady) {
    throw 'Expected PhoneReady mode.'
}
if (-not $StatePath) {
    throw 'Expected watchdog to pass a state path.'
}

$writeStateWithSleeper = [Environment]::GetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER', 'Process')
if ($writeStateWithSleeper -eq '1') {
    $sleepMillisecondsRaw = [Environment]::GetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS', 'Process')
    $sleepMilliseconds = if ([string]::IsNullOrWhiteSpace($sleepMillisecondsRaw)) {
        1200
    } else {
        [int]$sleepMillisecondsRaw
    }
    $nodePath = (Get-Command 'node.exe' -ErrorAction Stop).Source
    $sleeper = Start-Process -FilePath $nodePath -ArgumentList @(
        '-e',
        "setTimeout(() => process.exit(0), $sleepMilliseconds);"
    ) -WindowStyle Hidden -PassThru
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $unusedPort = [int]$listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }

    $stateDirectory = Split-Path -Parent $StatePath
    if ($stateDirectory -and -not (Test-Path -Path $stateDirectory)) {
        [void](New-Item -ItemType Directory -Path $stateDirectory -Force)
    }

    [pscustomobject]@{
        ListenUrl = "http://127.0.0.1:$unusedPort"
        AuthDisabled = $true
        RequestedPhoneReady = $true
        ProcessId = [int]$sleeper.Id
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding utf8
}

[pscustomobject]@{
    listenUrl = 'http://127.0.0.1:3360'
    preferredConnectUrl = 'https://agent-hub.example.ts.net'
    preferredConnectUrlSource = 'tailscale-serve'
    accessCode = 'test-access'
    oneTapPairingLink = 'https://agent-hub.example.ts.net/#accessCode=test-access'
} | ConvertTo-Json -Depth 4
'@

[System.IO.File]::WriteAllText($mockEnsurePath, $mockEnsureContent, [Text.Encoding]::UTF8)

$previousCounterPath = $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH
$previousWriteStateWithSleeper = $env:WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER
$previousSleeperMs = $env:WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS
$firstProcess = $null
$managerStatusJob = $null

try {
    $activeStatePath = Join-Path $tempRoot 'active-state\hub.json'
    $activeCounterPath = Join-Path $tempRoot 'active-counter.txt'
    $activeStatusPort = Get-FreeTcpPort
    $managerStatusJob = Start-MockManagerStatusServer -PortNumber $activeStatusPort -StatusJson '{"running":true,"configured":true,"builtinBackend":true,"currentQueueId":"q_active_watchdog"}'
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $activeStatePath)) | Out-Null
    [pscustomobject]@{
        ListenUrl = "http://127.0.0.1:$activeStatusPort/"
        AuthDisabled = $true
        RequestedPhoneReady = $true
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $activeStatePath -Encoding utf8

    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $activeCounterPath
    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $activeStatePath `
        -IntervalSeconds 1 `
        -MaxIterations 1

    if (Test-Path -Path $activeCounterPath) {
        $activeCountRaw = (Get-Content -Path $activeCounterPath -Raw -Encoding utf8).Trim()
        if ($activeCountRaw -and [int]$activeCountRaw -ne 0) {
            throw "Expected watchdog to skip ensure-web-ui-running.ps1 while Manager has an active assignment. Got $activeCountRaw."
        }
    }

    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $counterPath

    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $statePath `
        -IntervalSeconds 1 `
        -MaxIterations 2

    $countAfterTwoLoops = [int]((Get-Content -Path $counterPath -Raw -Encoding utf8).Trim())
    if ($countAfterTwoLoops -ne 2) {
        throw "Expected watchdog to invoke ensure-web-ui-running.ps1 twice. Got $countAfterTwoLoops."
    }

    $firstProcess = Start-Process `
        -FilePath (Get-Command 'powershell.exe' -ErrorAction Stop).Source `
        -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $scriptPath,
            '-EnsureScriptPath',
            $mockEnsurePath,
            '-StatePath',
            $statePath,
            '-IntervalSeconds',
            '3',
            '-MaxIterations',
            '2'
        ) `
        -PassThru `
        -WindowStyle Hidden

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if (Test-Path -Path $counterPath) {
            $rawCount = (Get-Content -Path $counterPath -Raw -Encoding utf8).Trim()
            if ($rawCount -and [int]$rawCount -gt $countAfterTwoLoops) {
                break
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    $countWhileLocked = [int]((Get-Content -Path $counterPath -Raw -Encoding utf8).Trim())
    if ($countWhileLocked -le $countAfterTwoLoops) {
        throw 'Expected the background watchdog instance to start before the duplicate launch check.'
    }

    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $statePath `
        -IntervalSeconds 1 `
        -MaxIterations 1

    Wait-Process -Id $firstProcess.Id -Timeout 20

    $finalCount = [int]((Get-Content -Path $counterPath -Raw -Encoding utf8).Trim())
    if ($finalCount -ne 4) {
        throw "Expected the duplicate watchdog attempt not to add extra ensure loops. Got $finalCount."
    }

    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER', '1', 'Process')
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS', '1200', 'Process')
    Set-Content -Path $counterPath -Value '0' -Encoding utf8
    if (Test-Path -Path $statePath) {
        [IO.File]::SetAttributes($statePath, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($statePath)
    }

    $fastRecoveryStopwatch = [Diagnostics.Stopwatch]::StartNew()
    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $statePath `
        -IntervalSeconds 30 `
        -MaxIterations 2
    $fastRecoveryStopwatch.Stop()

    $fastRecoveryCount = [int]((Get-Content -Path $counterPath -Raw -Encoding utf8).Trim())
    if ($fastRecoveryCount -ne 2) {
        throw "Expected process-exit wake-up mode to rerun ensure-web-ui-running.ps1 twice. Got $fastRecoveryCount."
    }
    if ($fastRecoveryStopwatch.Elapsed.TotalSeconds -ge 10) {
        throw "Expected watchdog to rerun shortly after process exit instead of waiting the full interval. Elapsed: $($fastRecoveryStopwatch.Elapsed.TotalSeconds)s"
    }
} finally {
    if ($firstProcess) {
        try {
            if (-not $firstProcess.HasExited) {
                Stop-Process -Id $firstProcess.Id -Force -ErrorAction Stop
            }
        } catch {
        }
    }

    if ($managerStatusJob) {
        try {
            Stop-Job -Job $managerStatusJob -ErrorAction Stop | Out-Null
        } catch {
        }
        try {
            Remove-Job -Job $managerStatusJob -Force -ErrorAction Stop | Out-Null
        } catch {
        }
    }

    if ($null -eq $previousCounterPath) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH', $previousCounterPath, 'Process')
    }

    if ($null -eq $previousWriteStateWithSleeper) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER', $previousWriteStateWithSleeper, 'Process')
    }

    if ($null -eq $previousSleeperMs) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS', $previousSleeperMs, 'Process')
    }

    if (Test-Path -Path $statePath) {
        try {
            $state = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($state.ProcessId) {
                Stop-Process -Id ([int]$state.ProcessId) -Force -ErrorAction SilentlyContinue
            }
        } catch {
        }
    }

    if ([System.IO.Directory]::Exists($tempRoot)) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}

Write-Output 'PASS'
