Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
$preferredPowerShell = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
$powerShellPath = if ($preferredPowerShell) { $preferredPowerShell.Source } else { $null }
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
        [AllowEmptyString()]
        [string]$Token = '',
        [Parameter(Mandatory = $true)]
        [string]$WorkspaceRoot,
        [Parameter(Mandatory = $true)]
        [string]$RunName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDirectory
    )

    $stdoutPath = Join-Path $TargetDirectory "$RunName.stdout.log"
    $stderrPath = Join-Path $TargetDirectory "$RunName.stderr.log"
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $ScriptPath,
        '-Port',
        [string]$PortNumber,
        '-StatePath',
        $TargetStatePath,
        '-WorkspaceRoot',
        $WorkspaceRoot,
        '-PhoneReady',
        '-JsonOutput'
    )
    if ($Token -and $Token.Trim()) {
        $argumentList += @(
            '-AuthToken',
            $Token.Trim()
        )
    }

    $process = Start-Process -FilePath $powerShellPath -ArgumentList $argumentList -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

    return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Wait-ForLaunchMetadata {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo,
        [int]$TimeoutMilliseconds = 60000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Test-Path -Path $ProcessInfo.StdOutPath) {
            try {
                $raw = Get-Content -Path $ProcessInfo.StdOutPath -Raw -Encoding utf8
                if ($raw -and $raw.Trim()) {
                    $trimmed = $raw.Trim()
                    try {
                        return ($trimmed | ConvertFrom-Json)
                    } catch {
                    }

                    $lines = $trimmed -split "\r?\n"
                    for ($index = $lines.Length - 1; $index -ge 0; $index -= 1) {
                        $candidateLines = $lines[$index..($lines.Length - 1)]
                        $candidate = ($candidateLines -join [Environment]::NewLine).Trim()
                        if (-not $candidate) {
                            continue
                        }
                        try {
                            return ($candidate | ConvertFrom-Json)
                        } catch {
                        }
                    }
                }
            } catch {
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected ensure-web-ui-running.ps1 to emit launch metadata in $($ProcessInfo.StdOutPath)."
}

function Wait-ForProcessSuccess {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo,
        [int]$TimeoutSeconds = 30
    )

    try {
        Wait-Process -Id $ProcessInfo.Process.Id -Timeout $TimeoutSeconds -ErrorAction Stop
    } catch {
        return
    }

    $exitCode = $null
    try {
        $exitCode = $ProcessInfo.Process.ExitCode
    } catch {
    }
    if ($null -eq $exitCode -or $exitCode -eq 0) {
        return
    }

    $detail = ''
    if (Test-Path -Path $ProcessInfo.StdErrPath) {
        $stderrRaw = Get-Content -Path $ProcessInfo.StdErrPath -Raw -Encoding utf8
        if ($null -ne $stderrRaw -and $stderrRaw.Trim()) {
            $detail = $stderrRaw.Trim()
        }
    }
    if (-not $detail -and (Test-Path -Path $ProcessInfo.StdOutPath)) {
        $stdoutRaw = Get-Content -Path $ProcessInfo.StdOutPath -Raw -Encoding utf8
        if ($null -ne $stdoutRaw -and $stdoutRaw.Trim()) {
            $detail = $stdoutRaw.Trim()
        }
    }

    if ($detail) {
        throw "ensure-web-ui-running.ps1 exited with code $exitCode during launch verification. $detail"
    }

    throw "ensure-web-ui-running.ps1 exited with code $exitCode during launch verification."
}

function Invoke-HubSessionsRequest {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [string]$Token = '',
        [int]$TimeoutSeconds = 3
    )

    $headers = @{}
    if ($Token -and $Token.Trim() -and $Token.Trim().ToLowerInvariant() -ne 'none') {
        $headers['X-Workspace-Agent-Hub-Token'] = $Token.Trim()
    }

    return Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/api/sessions?includeArchived=true" -Headers $headers -TimeoutSec $TimeoutSeconds -DisableKeepAlive -UseBasicParsing -ErrorAction Stop
}

function Wait-ForHubSessionsReady {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [string]$Token = '',
        [int]$TimeoutMilliseconds = 10000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $lastFailure = 'No response received.'
    do {
        try {
            $response = Invoke-HubSessionsRequest -PortNumber $PortNumber -Token $Token -TimeoutSeconds 1
            if ($response.StatusCode -eq 200) {
                return $response
            }
            $lastFailure = "HTTP $([int]$response.StatusCode)"
        } catch {
            $statusCode = $null
            $responseBody = ''
            $exception = $_.Exception
            $responseProperty = $null
            if ($exception -and $exception.PSObject.Properties.Match('Response').Count -gt 0) {
                $responseProperty = $exception.Response
            }
            if ($responseProperty) {
                try {
                    $statusCode = [int]$responseProperty.StatusCode
                } catch {
                }
                try {
                    $responseStream = $responseProperty.GetResponseStream()
                    if ($responseStream) {
                        $reader = [IO.StreamReader]::new($responseStream)
                        try {
                            $responseBody = $reader.ReadToEnd()
                        } finally {
                            $reader.Dispose()
                        }
                    }
                } catch {
                }
            }
            if ($null -ne $statusCode) {
                if ($responseBody) {
                    $lastFailure = "HTTP $statusCode $responseBody"
                } else {
                    $lastFailure = "HTTP $statusCode"
                }
            } else {
                $lastFailure = $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected the ensured Hub endpoint on port $PortNumber to answer API requests. Last failure: $lastFailure"
}

function Wait-ForPortClosed {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [int]$TimeoutMilliseconds = 15000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        try {
            $client = [Net.Sockets.TcpClient]::new()
            $task = $client.ConnectAsync('127.0.0.1', $PortNumber)
            if ($task.Wait(250)) {
                $client.Dispose()
            } else {
                $client.Dispose()
                return
            }
        } catch {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected port $PortNumber to close after swap."
}

$testDirectory = Join-Path $env:TEMP ('workspace-agent-hub-swap-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testDirectory -Force)
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$workspaceRoot = Split-Path -Parent $repoRoot
$frontDoorSourcePath = Join-Path $repoRoot 'src\web-ui-front-door.ts'
$originalFrontDoorSourceWriteTimeUtc = (Get-Item -LiteralPath $frontDoorSourcePath).LastWriteTimeUtc
$statePath = Join-Path $testDirectory 'state.json'
$stdoutPath = Join-Path $testDirectory 'swap.stdout.log'
$stderrPath = Join-Path $testDirectory 'swap.stderr.log'
$mockCliPath = Join-Path $testDirectory 'mock-web-ui.mjs'
$port = Get-FreeTcpPort
$originalCliPath = $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH
$originalSwapDelay = $env:WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS

$mockCliContent = @'
import http from "node:http";

const args = process.argv.slice(2);
let host = "127.0.0.1";
let port = 3360;
let authToken = "auto";

for (let index = 0; index < args.length; index += 1) {
  const current = args[index];
  if (current === "--host") {
    host = args[index + 1] ?? host;
    index += 1;
  } else if (current === "--port") {
    port = Number(args[index + 1] ?? port);
    index += 1;
  } else if (current === "--auth-token") {
    authToken = args[index + 1] ?? authToken;
    index += 1;
  }
}

const delayMs = Number(process.env.WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS ?? "0");
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const authRequired = authToken !== "none";
const accessCode = authRequired ? authToken : null;

function tryListen(targetPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/sessions")) {
        if (authRequired) {
          const tokenHeader = req.headers["x-workspace-agent-hub-token"];
          const authHeader = req.headers.authorization;
          const bearerToken =
            typeof authHeader === "string" && authHeader.startsWith("Bearer ")
              ? authHeader.slice("Bearer ".length)
              : "";
          if (tokenHeader !== accessCode && bearerToken !== accessCode) {
            res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "Access code required" }));
            return;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end("[]");
        return;
      }

      if (req.url === "/api/shutdown" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ shutting_down: true }));
        setTimeout(() => {
          server.close(() => process.exit(0));
        }, 10);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
    });

    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolve(tryListen(targetPort + 1));
        return;
      }
      reject(error);
    });

    server.listen(targetPort, host, () => {
      resolve({ server, actualPort: targetPort });
    });
  });
}

const { actualPort } = await tryListen(port);
const preferredConnectUrl = "https://agent-hub.example.ts.net";
console.log(
  JSON.stringify({
    listenUrl: `http://${host}:${actualPort}`,
    preferredConnectUrl,
    preferredConnectUrlSource: "tailscale-serve",
    authRequired,
    accessCode,
    oneTapPairingLink: authRequired
      ? `${preferredConnectUrl}#accessCode=${encodeURIComponent(accessCode)}`
      : preferredConnectUrl,
  })
);
'@

[IO.File]::WriteAllText($mockCliPath, $mockCliContent, [Text.UTF8Encoding]::new($false))

function Stop-ProcessesForStatePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    Stop-ProcessesForCommandLinePattern -CommandLinePattern $TargetStatePath
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $childProcesses = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId")
    foreach ($childProcess in $childProcesses) {
        Stop-ProcessTree -ProcessId ([int]$childProcess.ProcessId)
    }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    } catch {
    }
    try {
        Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction Stop
    } catch {
    }
}

function Stop-ProcessesForCommandLinePattern {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLinePattern
    )

    $escapedPattern = [regex]::Escape($CommandLinePattern)
    $processes = Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $escapedPattern
    }
    foreach ($processInfo in $processes) {
        Stop-ProcessTree -ProcessId ([int]$processInfo.ProcessId)
    }
}

function Remove-TestDirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDirectory,
        [int]$TimeoutMilliseconds = 10000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (-not [IO.Directory]::Exists($TargetDirectory)) {
            return
        }
        try {
            [IO.Directory]::Delete($TargetDirectory, $true)
        } catch {
        }
        if (-not [IO.Directory]::Exists($TargetDirectory)) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected temporary swap test directory to be deleted: $TargetDirectory"
}

$firstRun = $null
$replacementRun = $null
try {
    (Get-Item -LiteralPath $frontDoorSourcePath).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(1)
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_CLI_PATH', $mockCliPath, 'Process')
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', '0', 'Process')

    $firstRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -WorkspaceRoot $workspaceRoot -RunName 'first' -TargetDirectory $testDirectory
    $first = Wait-ForLaunchMetadata -ProcessInfo $firstRun
    Wait-ForProcessSuccess -ProcessInfo $firstRun

    $firstPort = ([Uri][string]$first.ListenUrl).Port
    $firstFrontDoorPort = ([Uri][string]$first.FrontDoorListenUrl).Port
    $firstFrontDoorResponse = Wait-ForHubSessionsReady -PortNumber $firstFrontDoorPort -TimeoutMilliseconds 10000
    if ($firstFrontDoorResponse.StatusCode -ne 200) {
        throw 'Expected the first ensured front door to answer API requests.'
    }

    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', '2500', 'Process')
    $replacementRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'replacement-token' -WorkspaceRoot $workspaceRoot -RunName 'replacement' -TargetDirectory $testDirectory

    $frontDoorStayedAvailable = $false
    $availabilityDeadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        try {
            $response = Invoke-HubSessionsRequest -PortNumber $firstFrontDoorPort -TimeoutSeconds 1
            if ($response.StatusCode -eq 200) {
                $frontDoorStayedAvailable = $true
                break
            }
        } catch {
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $availabilityDeadline)

    if (-not $frontDoorStayedAvailable) {
        throw 'Expected the stable front door to stay available while the replacement instance was still starting.'
    }

    $replacement = Wait-ForLaunchMetadata -ProcessInfo $replacementRun
    Wait-ForProcessSuccess -ProcessInfo $replacementRun

    $replacementPort = ([Uri][string]$replacement.ListenUrl).Port
    $replacementFrontDoorPort = ([Uri][string]$replacement.FrontDoorListenUrl).Port
    if ($replacementPort -eq $firstPort) {
        throw 'Expected replacement startup to use a different port while the previous listener was still alive.'
    }
    if ($replacementFrontDoorPort -ne $firstFrontDoorPort) {
        throw 'Expected replacement startup to keep the same front-door port while swapping the upstream listener.'
    }
    $replacementFrontDoorResponse = Wait-ForHubSessionsReady -PortNumber $replacementFrontDoorPort -Token 'replacement-token' -TimeoutMilliseconds 10000
    if ($replacementFrontDoorResponse.StatusCode -ne 200) {
        throw 'Expected the stable front door to route to the replacement listener after swap.'
    }

    Wait-ForPortClosed -PortNumber $firstPort
} finally {
    if (Test-Path -LiteralPath $frontDoorSourcePath) {
        (Get-Item -LiteralPath $frontDoorSourcePath).LastWriteTimeUtc = $originalFrontDoorSourceWriteTimeUtc
    }

    foreach ($processInfo in @($firstRun, $replacementRun)) {
        if ($null -eq $processInfo) {
            continue
        }
        if ($processInfo.PSObject.Properties.Match('Process').Count -eq 0 -or -not $processInfo.Process) {
            continue
        }
        try {
            Stop-ProcessTree -ProcessId ([int]$processInfo.Process.Id)
        } catch {
        }
    }

    if (Test-Path -Path $statePath) {
        try {
            $state = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
            foreach ($propertyName in @('ProcessId', 'FrontDoorProcessId')) {
                if (
                    $state.PSObject.Properties.Match($propertyName).Count -gt 0 -and
                    $state.$propertyName
                ) {
                    try {
                        Stop-Process -Id ([int]$state.$propertyName) -Force -ErrorAction Stop
                    } catch {
                    }
                    try {
                        Wait-Process -Id ([int]$state.$propertyName) -Timeout 5 -ErrorAction Stop
                    } catch {
                    }
                }
            }
        } catch {
        }
    }
    Stop-ProcessesForStatePath -TargetStatePath $statePath
    Stop-ProcessesForCommandLinePattern -CommandLinePattern $mockCliPath

    if ($null -eq $originalCliPath) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_CLI_PATH', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_CLI_PATH', $originalCliPath, 'Process')
    }

    if ($null -eq $originalSwapDelay) {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', $null, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', $originalSwapDelay, 'Process')
    }

    if ([IO.Directory]::Exists($testDirectory)) {
        Remove-TestDirectoryWithRetry -TargetDirectory $testDirectory
    }
}

Write-Output 'PASS'
