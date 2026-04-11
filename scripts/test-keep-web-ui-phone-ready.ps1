Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'keep-web-ui-phone-ready.ps1'
$currentWorkspaceRoot = Split-Path -Parent ((Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wah-phone-ready-" + [Guid]::NewGuid().ToString('N'))
$statePath = Join-Path $tempRoot 'state\hub.json'
$counterPath = Join-Path $tempRoot 'counter.txt'
$mockEnsurePath = Join-Path $tempRoot 'mock-ensure.ps1'
$mockServerPath = Join-Path $tempRoot 'mock-http-server.mjs'

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

function Start-MockHttpServer {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [int]$StatusCode,
        [Parameter(Mandatory = $true)]
        [string]$Body
    )

    $nodePath = (Get-Command 'node.exe' -ErrorAction Stop).Source
    $bodyPath = Join-Path $tempRoot ("mock-http-body-" + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($bodyPath, $Body, [Text.UTF8Encoding]::new($false))
    $process = Start-Process -FilePath $nodePath -ArgumentList @(
        $mockServerPath,
        '--port', [string]$PortNumber,
        '--path', $Path,
        '--status', [string]$StatusCode,
        '--body-file', $bodyPath
    ) -PassThru -WindowStyle Hidden

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try {
            $response = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $PortNumber, $Path) -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq $StatusCode) {
                return $process
            }
        } catch {
            if (
                $null -ne $_.Exception.Response -and
                $null -ne $_.Exception.Response.StatusCode -and
                [int]$_.Exception.Response.StatusCode -eq $StatusCode
            ) {
                return $process
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
    }

    throw "Expected the mock HTTP server for $Path to become ready."
}

function Start-MockManagerStatusServer {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [Parameter(Mandatory = $true)]
        [string]$StatusJson
    )

    return (Start-MockHttpServer `
        -PortNumber $PortNumber `
        -Path '/manager/api/manager/status' `
        -StatusCode 200 `
        -Body $StatusJson)
}

function Start-MockFrontDoorServer {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [int]$StatusCode = 200
    )

    return (Start-MockHttpServer `
        -PortNumber $PortNumber `
        -Path '/api/front-door/health' `
        -StatusCode $StatusCode `
        -Body '{"ok":true}')
}

$mockEnsureContent = @'
param(
    [int]$Port = 3360,
    [string]$AuthToken = '',
    [string]$StatePath = '',
    [string]$WorkspaceRoot = '',
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
$expectedWorkspaceRoot = [Environment]::GetEnvironmentVariable('WORKSPACE_AGENT_HUB_EXPECT_WORKSPACE_ROOT', 'Process')
if (-not [string]::IsNullOrWhiteSpace($expectedWorkspaceRoot)) {
    if ([IO.Path]::GetFullPath($WorkspaceRoot) -ne [IO.Path]::GetFullPath($expectedWorkspaceRoot)) {
        throw "Expected WorkspaceRoot '$expectedWorkspaceRoot' but got '$WorkspaceRoot'."
    }
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

$mockServerContent = @'
import http from "node:http";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let port = 0;
let path = "/";
let status = 200;
let body = "{}";
let bodyFile = "";

for (let index = 0; index < args.length; index += 1) {
  const current = args[index];
  if (current === "--port") {
    port = Number(args[index + 1] ?? port);
    index += 1;
  } else if (current === "--path") {
    path = args[index + 1] ?? path;
    index += 1;
  } else if (current === "--status") {
    status = Number(args[index + 1] ?? status);
    index += 1;
  } else if (current === "--body-file") {
    bodyFile = args[index + 1] ?? bodyFile;
    index += 1;
  }
}

if (bodyFile) {
  body = readFileSync(bodyFile, "utf8");
}

const server = http.createServer((req, res) => {
  if ((req.url ?? "") === path) {
    const payload = body;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1");
'@

[System.IO.File]::WriteAllText($mockEnsurePath, $mockEnsureContent, [Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($mockServerPath, $mockServerContent, [Text.Encoding]::UTF8)

$previousCounterPath = $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH
$previousWriteStateWithSleeper = $env:WORKSPACE_AGENT_HUB_TEST_WRITE_STATE_WITH_SLEEPER
$previousSleeperMs = $env:WORKSPACE_AGENT_HUB_TEST_SLEEPER_MS
$previousTailscaleServeStatusText = $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT
$previousExpectedWorkspaceRoot = $env:WORKSPACE_AGENT_HUB_EXPECT_WORKSPACE_ROOT
$testPassed = $false
$firstProcess = $null
$managerStatusJob = $null
$staleServeManagerJob = $null
$frontDoorHealthyJob = $null
$frontDoorStaleServeJob = $null

try {
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_EXPECT_WORKSPACE_ROOT', $currentWorkspaceRoot, 'Process')
    $activeStatePath = Join-Path $tempRoot 'active-state\hub.json'
    $activeCounterPath = Join-Path $tempRoot 'active-counter.txt'
    $activeStatusPort = Get-FreeTcpPort
    $activeFrontDoorPort = Get-FreeTcpPort
    $managerStatusJob = Start-MockManagerStatusServer -PortNumber $activeStatusPort -StatusJson '{"running":true,"configured":true,"builtinBackend":true,"currentQueueId":"q_active_watchdog"}'
    $frontDoorHealthyJob = Start-MockFrontDoorServer -PortNumber $activeFrontDoorPort -StatusCode 200
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $activeStatePath)) | Out-Null
    [pscustomobject]@{
        ListenUrl = "http://127.0.0.1:$activeStatusPort/"
        FrontDoorListenUrl = "http://127.0.0.1:$activeFrontDoorPort/"
        PreferredConnectUrlSource = 'tailscale-serve'
        AuthDisabled = $true
        RequestedPhoneReady = $true
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $activeStatePath -Encoding utf8

    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://agent-hub.example.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$activeFrontDoorPort
"@
    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $activeCounterPath
    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $activeStatePath `
        -WorkspaceRoot $currentWorkspaceRoot `
        -IntervalSeconds 1 `
        -MaxIterations 1

    if (Test-Path -Path $activeCounterPath) {
        $activeCountRaw = (Get-Content -Path $activeCounterPath -Raw -Encoding utf8).Trim()
        if ($activeCountRaw -and [int]$activeCountRaw -ne 0) {
            throw "Expected watchdog to skip ensure-web-ui-running.ps1 while Manager has an active assignment. Got $activeCountRaw."
        }
    }

    $directPromoteStatePath = Join-Path $tempRoot 'direct-promote-state\hub.json'
    $directPromoteCounterPath = Join-Path $tempRoot 'direct-promote-counter.txt'
    $directPromoteStatusPort = Get-FreeTcpPort
    $directPromoteFrontDoorPort = Get-FreeTcpPort
    $directPromoteManagerJob = Start-MockManagerStatusServer -PortNumber $directPromoteStatusPort -StatusJson '{"running":true,"configured":true,"builtinBackend":true,"currentQueueId":"q_direct_promote"}'
    $directPromoteFrontDoorJob = Start-MockFrontDoorServer -PortNumber $directPromoteFrontDoorPort -StatusCode 200
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $directPromoteStatePath)) | Out-Null
    [pscustomobject]@{
        ListenUrl = "http://127.0.0.1:$directPromoteStatusPort/"
        FrontDoorListenUrl = "http://127.0.0.1:$directPromoteFrontDoorPort/"
        PreferredConnectUrlSource = 'tailscale-direct'
        AuthDisabled = $true
        RequestedPhoneReady = $true
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $directPromoteStatePath -Encoding utf8

    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $directPromoteCounterPath
    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://agent-hub.example.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$directPromoteFrontDoorPort
"@
    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $directPromoteStatePath `
        -WorkspaceRoot $currentWorkspaceRoot `
        -IntervalSeconds 1 `
        -MaxIterations 1

    $directPromoteCount = [int]((Get-Content -Path $directPromoteCounterPath -Raw -Encoding utf8).Trim())
    if ($directPromoteCount -ne 1) {
        throw "Expected watchdog to rerun ensure-web-ui-running.ps1 when direct mode can be promoted to the matching Tailscale Serve front door. Got $directPromoteCount."
    }

    $staleServeStatePath = Join-Path $tempRoot 'stale-serve-state\hub.json'
    $staleServeCounterPath = Join-Path $tempRoot 'stale-serve-counter.txt'
    $staleServeStatusPort = Get-FreeTcpPort
    $staleServeFrontDoorPort = Get-FreeTcpPort
    $staleServeManagerJob = Start-MockManagerStatusServer -PortNumber $staleServeStatusPort -StatusJson '{"running":true,"configured":true,"builtinBackend":true,"currentQueueId":"q_stale_serve"}'
    $frontDoorStaleServeJob = Start-MockFrontDoorServer -PortNumber $staleServeFrontDoorPort -StatusCode 200
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $staleServeStatePath)) | Out-Null
    [pscustomobject]@{
        ListenUrl = "http://127.0.0.1:$staleServeStatusPort/"
        FrontDoorListenUrl = "http://127.0.0.1:$staleServeFrontDoorPort/"
        PreferredConnectUrlSource = 'tailscale-serve'
        AuthDisabled = $true
        RequestedPhoneReady = $true
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $staleServeStatePath -Encoding utf8

    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $staleServeCounterPath
    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @'
https://agent-hub.example.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:57921
'@
    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $staleServeStatePath `
        -WorkspaceRoot $currentWorkspaceRoot `
        -IntervalSeconds 1 `
        -MaxIterations 1

    $staleServeCount = [int]((Get-Content -Path $staleServeCounterPath -Raw -Encoding utf8).Trim())
    if ($staleServeCount -ne 1) {
        throw "Expected watchdog to rerun ensure-web-ui-running.ps1 when Tailscale Serve drifts away from the front door. Got $staleServeCount."
    }

    $env:WORKSPACE_AGENT_HUB_TEST_COUNTER_PATH = $counterPath
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT', $null, 'Process')

    & $scriptPath `
        -EnsureScriptPath $mockEnsurePath `
        -StatePath $statePath `
        -WorkspaceRoot $currentWorkspaceRoot `
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
            '-WorkspaceRoot',
            $currentWorkspaceRoot,
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
        -WorkspaceRoot $currentWorkspaceRoot `
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
        -WorkspaceRoot $currentWorkspaceRoot `
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

    $testPassed = $true
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
            Stop-Process -Id $managerStatusJob.Id -Force -ErrorAction Stop
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

    if ($null -eq $previousTailscaleServeStatusText) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT', $previousTailscaleServeStatusText, 'Process')
    }

    if ($null -eq $previousExpectedWorkspaceRoot) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_EXPECT_WORKSPACE_ROOT', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_EXPECT_WORKSPACE_ROOT', $previousExpectedWorkspaceRoot, 'Process')
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

    foreach ($job in @($directPromoteManagerJob, $directPromoteFrontDoorJob, $staleServeManagerJob, $frontDoorHealthyJob, $frontDoorStaleServeJob)) {
        if (-not $job) {
            continue
        }
        try {
            Stop-Process -Id $job.Id -Force -ErrorAction Stop
        } catch {
        }
    }

    $keepTempOnFailure = (
        -not $testPassed -and
        [Environment]::GetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_KEEP_TEMP_ON_FAILURE', 'Process') -eq '1'
    )
    if ([System.IO.Directory]::Exists($tempRoot) -and -not $keepTempOnFailure) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}

Write-Output 'PASS'
