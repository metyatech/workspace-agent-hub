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

    $headers = @{
        Connection = 'close'
    }
    if ($Token -and $Token.Trim() -and $Token.Trim().ToLowerInvariant() -ne 'none') {
        $headers['X-Workspace-Agent-Hub-Token'] = $Token.Trim()
    }

    return Invoke-WebRequest -Uri "http://127.0.0.1:$PortNumber/api/sessions?includeArchived=true" -Headers $headers -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
}

function Wait-ForHubSessionsReady {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [string]$Token = '',
        [int]$TimeoutMilliseconds = 10000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        try {
            $response = Invoke-HubSessionsRequest -PortNumber $PortNumber -Token $Token -TimeoutSeconds 1
            if ($response.StatusCode -eq 200) {
                return $response
            }
        } catch {
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Expected the ensured web UI on port $PortNumber to answer API requests."
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

try {
    (Get-Item -LiteralPath $frontDoorSourcePath).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(1)
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_CLI_PATH', $mockCliPath, 'Process')
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', '0', 'Process')

    $firstRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -RunName 'first' -TargetDirectory $testDirectory
    $first = Wait-ForLaunchMetadata -ProcessInfo $firstRun
    Wait-ForProcessSuccess -ProcessInfo $firstRun

    $firstPort = ([Uri][string]$first.ListenUrl).Port
    $firstResponse = Wait-ForHubSessionsReady -PortNumber $firstPort -TimeoutMilliseconds 10000
    if ($firstResponse.StatusCode -ne 200) {
        throw 'Expected the first ensured instance to answer API requests.'
    }

    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_SWAP_DELAY_MS', '2500', 'Process')
    $replacementRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'replacement-token' -RunName 'replacement' -TargetDirectory $testDirectory

    $oldPortStayedAvailable = $false
    $availabilityDeadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        try {
            $response = Invoke-HubSessionsRequest -PortNumber $firstPort -TimeoutSeconds 1
            if ($response.StatusCode -eq 200) {
                $oldPortStayedAvailable = $true
                break
            }
        } catch {
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $availabilityDeadline)

    if (-not $oldPortStayedAvailable) {
        throw 'Expected the previous Hub listener to stay available while the replacement instance was still starting.'
    }

    $replacement = Wait-ForLaunchMetadata -ProcessInfo $replacementRun
    Wait-ForProcessSuccess -ProcessInfo $replacementRun

    $replacementPort = ([Uri][string]$replacement.ListenUrl).Port
    if ($replacementPort -eq $firstPort) {
        throw 'Expected replacement startup to use a different port while the previous listener was still alive.'
    }

    $replacementResponse = Wait-ForHubSessionsReady -PortNumber $replacementPort -Token 'replacement-token' -TimeoutMilliseconds 10000
    if ($replacementResponse.StatusCode -ne 200) {
        throw 'Expected the replacement listener to answer API requests with the requested auth token.'
    }

    Wait-ForPortClosed -PortNumber $firstPort
} finally {
    if (Test-Path -LiteralPath $frontDoorSourcePath) {
        (Get-Item -LiteralPath $frontDoorSourcePath).LastWriteTimeUtc = $originalFrontDoorSourceWriteTimeUtc
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
        try {
            [IO.Directory]::Delete($testDirectory, $true)
        } catch {
        }
    }
}

Write-Output 'PASS'
