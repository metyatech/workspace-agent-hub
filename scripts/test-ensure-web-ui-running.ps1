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
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Test-Path -Path $ProcessInfo.StdOutPath) {
            try {
                $raw = Get-Content -Path $ProcessInfo.StdOutPath -Raw -Encoding utf8
                if ($raw -and $raw.Trim()) {
                    return ($raw | ConvertFrom-Json)
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

    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -Path $ProcessInfo.StdErrPath)) {
        return
    }

    $stderrRaw = Get-Content -Path $ProcessInfo.StdErrPath -Raw -Encoding utf8
    if ($null -eq $stderrRaw) {
        $stderrRaw = ''
    }
    $stderrText = $stderrRaw.Trim()
    if (-not $stderrText) {
        return
    }

    throw "ensure-web-ui-running.ps1 emitted stderr during launch verification. $stderrText"
}

function Wait-ForApiReady {
    param(
        [Parameter(Mandatory = $true)]
        [int]$PortNumber,
        [string]$Token = '',
        [int]$TimeoutMilliseconds = 30000
    )

    $headers = @{}
    if ($Token -and $Token.Trim() -and $Token.Trim().ToLowerInvariant() -ne 'none') {
        $headers['X-Workspace-Agent-Hub-Token'] = $Token.Trim()
    }
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
$mockCliPath = Join-Path $testDirectory 'mock-web-ui.mjs'
$port = Get-FreeTcpPort
$testPassed = $false
$originalTailscaleServeStatusText = $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT
$originalCliPath = $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH

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
      resolve({ actualPort: targetPort });
    });
  });
}

const { actualPort } = await tryListen(port);
const preferredConnectUrl = "https://desktop-dr5v76c.tail5a2d2d.ts.net";
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
    [Environment]::SetEnvironmentVariable('WORKSPACE_AGENT_HUB_TEST_CLI_PATH', $mockCliPath, 'Process')
    $firstRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'first' -TargetDirectory $testDirectory
    $first = Wait-ForLaunchMetadata -ProcessInfo $firstRun
    Wait-ForProcessSuccess -ProcessInfo $firstRun

    if (-not $first.ListenUrl) {
        throw 'Expected ensure-web-ui-running.ps1 to return a listen URL.'
    }
    if ($null -ne $first.AccessCode) {
        throw 'Expected ensure-web-ui-running.ps1 to default to no access code in PhoneReady mode.'
    }
    if (-not [bool]$first.AuthDisabled) {
        throw 'Expected ensure-web-ui-running.ps1 to persist that PhoneReady mode disables the extra app auth layer by default.'
    }

    $firstPort = ([Uri][string]$first.ListenUrl).Port
    Wait-ForApiReady -PortNumber $firstPort -Token ''
    if ([string]$first.PreferredConnectUrlSource -eq 'tailscale-serve') {
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$firstPort
"@
    }

    $secondRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'second' -TargetDirectory $testDirectory
    $second = Wait-ForLaunchMetadata -ProcessInfo $secondRun
    Wait-ForProcessSuccess -ProcessInfo $secondRun
    $secondPort = ([Uri][string]$second.ListenUrl).Port
    Wait-ForApiReady -PortNumber $secondPort -Token ''

    if ([string]$second.ListenUrl -ne [string]$first.ListenUrl) {
        throw 'Expected ensure-web-ui-running.ps1 to reuse the existing instance when it is already healthy.'
    }
    if ($null -ne $second.AccessCode) {
        throw 'Expected ensure-web-ui-running.ps1 to keep the no-auth PhoneReady state on reuse.'
    }
    if ([int]$second.ProcessId -ne [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to reuse the same background process when the instance is already healthy.'
    }

    $legacyState = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    $legacyState.RequestedPhoneReady = $false
    ($legacyState | ConvertTo-Json -Depth 8) | Set-Content -Path $statePath -Encoding utf8

    $legacyUpgradeRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'legacy-upgrade' -TargetDirectory $testDirectory
    $legacyUpgrade = Wait-ForLaunchMetadata -ProcessInfo $legacyUpgradeRun
    Wait-ForProcessSuccess -ProcessInfo $legacyUpgradeRun
    Wait-ForApiReady -PortNumber ([Uri][string]$legacyUpgrade.ListenUrl).Port -Token ''
    if ([string]$legacyUpgrade.PreferredConnectUrlSource -eq 'tailscale-serve') {
        $legacyUpgradePort = ([Uri][string]$legacyUpgrade.ListenUrl).Port
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$legacyUpgradePort
"@
    }

    if ([int]$legacyUpgrade.ProcessId -eq [int]$first.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to restart when the saved state predates the required PhoneReady marker.'
    }

    $upgradedState = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not [bool]$upgradedState.RequestedPhoneReady) {
        throw 'Expected ensure-web-ui-running.ps1 to persist the required PhoneReady launch mode marker.'
    }

    $upgradedReuseRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'upgraded-reuse' -TargetDirectory $testDirectory
    $upgradedReuse = Wait-ForLaunchMetadata -ProcessInfo $upgradedReuseRun
    Wait-ForProcessSuccess -ProcessInfo $upgradedReuseRun
    Wait-ForApiReady -PortNumber ([Uri][string]$upgradedReuse.ListenUrl).Port -Token ''

    if ([int]$upgradedReuse.ProcessId -ne [int]$legacyUpgrade.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to reuse the existing process once the PhoneReady marker is present.'
    }

    $tailscaleState = Get-Content -Path $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    $tailscaleState.PreferredConnectUrlSource = 'tailscale-serve'
    $tailscaleState.PreferredConnectUrl = 'https://desktop-dr5v76c.tail5a2d2d.ts.net'
    ($tailscaleState | ConvertTo-Json -Depth 8) | Set-Content -Path $statePath -Encoding utf8
    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @"
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:$([Uri][string]$legacyUpgrade.ListenUrl).Port
"@

    $serveHealthyRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'serve-healthy' -TargetDirectory $testDirectory
    $serveHealthy = Wait-ForLaunchMetadata -ProcessInfo $serveHealthyRun
    Wait-ForProcessSuccess -ProcessInfo $serveHealthyRun
    $serveHealthyPort = ([Uri][string]$serveHealthy.ListenUrl).Port
    Wait-ForApiReady -PortNumber $serveHealthyPort -Token ''
    if ([string]$serveHealthy.PreferredConnectUrlSource -ne 'tailscale-serve') {
        throw 'Expected ensure-web-ui-running.ps1 to keep the Tailscale Serve smartphone path when the saved proxy target still matches the listener port.'
    }

    $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT = @'
https://desktop-dr5v76c.tail5a2d2d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:57921
'@

    $serveMismatchRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'serve-mismatch' -TargetDirectory $testDirectory
    $serveMismatch = Wait-ForLaunchMetadata -ProcessInfo $serveMismatchRun
    Wait-ForProcessSuccess -ProcessInfo $serveMismatchRun
    $serveMismatchPort = ([Uri][string]$serveMismatch.ListenUrl).Port
    Wait-ForApiReady -PortNumber $serveMismatchPort -Token ''

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

    $stalePidRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token '' -RunName 'stale-pid' -TargetDirectory $testDirectory
    $stalePid = Wait-ForLaunchMetadata -ProcessInfo $stalePidRun
    Wait-ForProcessSuccess -ProcessInfo $stalePidRun
    Wait-ForApiReady -PortNumber ([Uri][string]$stalePid.ListenUrl).Port -Token ''

    if ([int]$stalePid.ProcessId -ne [int]$serveMismatch.ProcessId) {
        throw 'Expected ensure-web-ui-running.ps1 to recover the real listener PID when the saved wrapper PID is stale.'
    }

    $thirdRun = Start-EnsureProcess -ScriptPath $ensureScriptPath -PortNumber $port -TargetStatePath $statePath -Token 'ensure-next-token' -RunName 'third' -TargetDirectory $testDirectory
    $third = Wait-ForLaunchMetadata -ProcessInfo $thirdRun
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
    if ($null -eq $originalCliPath) {
        Remove-Item Env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH -ErrorAction SilentlyContinue
    } else {
        $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH = $originalCliPath
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
