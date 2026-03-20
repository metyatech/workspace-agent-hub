param(
    [int]$Port = 3360,
    [string]$AuthToken = '',
    [string]$StatePath = '',
    [switch]$OpenBrowser,
    [switch]$JsonOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$startScriptPath = Join-Path $PSScriptRoot 'start-web-ui.ps1'
if (-not (Test-Path -Path $startScriptPath)) {
    throw "Missing script: $startScriptPath"
}

function Get-DefaultStatePath {
    $stateDirectory = Join-Path $env:USERPROFILE 'agent-handoff'
    return (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.json')
}

function Ensure-StateDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    $stateDirectory = Split-Path -Parent $TargetStatePath
    if (-not (Test-Path -Path $stateDirectory)) {
        [void](New-Item -ItemType Directory -Path $stateDirectory -Force)
    }
}

function Read-State {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    if (-not (Test-Path -Path $TargetStatePath)) {
        return $null
    }

    $raw = Get-Content -Path $TargetStatePath -Raw -Encoding utf8
    if ($null -eq $raw) {
        $raw = ''
    }
    $raw = $raw.Trim()
    if (-not $raw) {
        return $null
    }

    return ($raw | ConvertFrom-Json)
}

function Write-State {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath,
        [Parameter(Mandatory = $true)]
        [psobject]$State
    )

    Ensure-StateDirectory -TargetStatePath $TargetStatePath
    ($State | ConvertTo-Json -Depth 8) | Set-Content -Path $TargetStatePath -Encoding utf8
}

function New-AccessCode {
    $bytes = New-Object byte[] 18
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    return $token
}

function Get-ResolvedAuthToken {
    param(
        $ExistingState
    )

    if ($AuthToken -and $AuthToken.Trim()) {
        return $AuthToken.Trim()
    }

    if ($ExistingState -and $ExistingState.AccessCode) {
        return ([string]$ExistingState.AccessCode).Trim()
    }

    if ($env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN) {
        return ([string]$env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN).Trim()
    }

    return (New-AccessCode)
}

function Get-PowerShellPath {
    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command 'powershell.exe' -ErrorAction Stop).Source
}

function Get-BrowserUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl,
        [string]$Token
    )

    $uri = [Uri]$ListenUrl
    $builder = [UriBuilder]::new($uri)
    if ($Token -and $Token.Trim()) {
        $builder.Fragment = 'accessCode=' + [Uri]::EscapeDataString($Token.Trim())
    } else {
        $builder.Fragment = ''
    }
    return $builder.Uri.AbsoluteUri
}

function Get-LocalReachableUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl
    )

    $uri = [Uri]$ListenUrl
    if ($uri.Host -notin @('0.0.0.0', '::', '[::]')) {
        return $uri.AbsoluteUri
    }

    $builder = [UriBuilder]::new($uri)
    $builder.Host = '127.0.0.1'
    return $builder.Uri.AbsoluteUri
}

function Get-ListenerProcessId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl
    )

    try {
        $uri = [Uri]$ListenUrl
        $listeners = Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction Stop
        foreach ($listener in $listeners) {
            if ($listener.OwningProcess) {
                return [int]$listener.OwningProcess
            }
        }
    } catch {
    }

    return $null
}

function Get-TailscaleServeProxyTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StatusText
    )

    $match = [regex]::Match(
        $StatusText,
        '(?im)^\|--\s+/\s+proxy\s+(\S+)\s*$'
    )
    if ($match.Success) {
        return $match.Groups[1].Value.Trim()
    }

    return $null
}

function Get-TailscaleServeStatusText {
    if (
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT -and
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT.Trim()
    ) {
        return $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_SERVE_STATUS_TEXT.Trim()
    }

    try {
        return (& tailscale serve status 2>&1 | Out-String).Trim()
    } catch {
        return ''
    }
}

function Test-TailscaleServeTargetMatchesListenUrl {
    param(
        $ExistingState,
        [string]$ListenUrl
    )

    if (
        -not $ExistingState -or
        [string]$ExistingState.PreferredConnectUrlSource -ne 'tailscale-serve'
    ) {
        return $true
    }

    if (-not $ListenUrl) {
        return $false
    }

    try {
        $listenUri = [Uri]$ListenUrl
        $statusText = Get-TailscaleServeStatusText
        if (-not $statusText) {
            return $false
        }

        $proxyTarget = Get-TailscaleServeProxyTarget -StatusText $statusText
        if (-not $proxyTarget) {
            return $false
        }

        $proxyUri = [Uri]$proxyTarget
        $loopbackHosts = @('127.0.0.1', 'localhost', '::1', '[::1]')
        return (
            $proxyUri.Scheme -eq 'http' -and
            $loopbackHosts -contains $proxyUri.Host.ToLowerInvariant() -and
            $proxyUri.Port -eq $listenUri.Port
        )
    } catch {
        return $false
    }
}

function Test-WebUiReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl,
        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    try {
        $headers = @{}
        if ($Token -and $Token.Trim()) {
            $headers['X-Workspace-Agent-Hub-Token'] = $Token.Trim()
        }
        $response = Invoke-WebRequest -Uri ($ListenUrl.TrimEnd('/') + '/api/sessions?includeArchived=true') -Method Get -Headers $headers -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Wait-ForWebUiReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl,
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [int]$TimeoutMilliseconds = 30000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Test-WebUiReady -ListenUrl $ListenUrl -Token $Token) {
            return $true
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

function Stop-ManagedProcessIfPresent {
    param(
        $ExistingState,
        [int]$FallbackProcessId = 0
    )

    $candidateProcessIds = [System.Collections.Generic.List[int]]::new()
    if ($ExistingState -and $ExistingState.ProcessId) {
        $candidateProcessIds.Add([int]$ExistingState.ProcessId)
    }
    if ($FallbackProcessId -gt 0 -and -not $candidateProcessIds.Contains($FallbackProcessId)) {
        $candidateProcessIds.Add($FallbackProcessId)
    }

    if ($candidateProcessIds.Count -eq 0) {
        return
    }

    foreach ($candidateProcessId in $candidateProcessIds) {
        try {
            $process = Get-Process -Id $candidateProcessId -ErrorAction Stop
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            try {
                Wait-Process -Id $process.Id -Timeout 10 -ErrorAction Stop
            } catch {
            }
        } catch {
        }
    }
}

function Test-ManagedProcessAlive {
    param(
        $ExistingState
    )

    if (-not $ExistingState -or -not $ExistingState.ProcessId) {
        return $false
    }

    try {
        [void](Get-Process -Id ([int]$ExistingState.ProcessId) -ErrorAction Stop)
        return $true
    } catch {
        return $false
    }
}

function Resolve-LogPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CandidatePath
    )

    if (-not (Test-Path -Path $CandidatePath)) {
        return $CandidatePath
    }

    try {
        [IO.File]::SetAttributes($CandidatePath, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($CandidatePath)
        return $CandidatePath
    } catch {
        $directory = Split-Path -Parent $CandidatePath
        $stem = [IO.Path]::GetFileNameWithoutExtension($CandidatePath)
        $extension = [IO.Path]::GetExtension($CandidatePath)
        return (Join-Path $directory ("{0}-{1}{2}" -f $stem, ([guid]::NewGuid().ToString('N')), $extension))
    }
}

function Wait-ForLaunchInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StdOutPath,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -Path $StdOutPath) {
            $raw = Get-Content -Path $StdOutPath -Raw -Encoding utf8
            if ($null -eq $raw) {
                $raw = ''
            }
            $trimmed = $raw.Trim()
            if ($trimmed) {
                try {
                    return ($trimmed | ConvertFrom-Json)
                } catch {
                }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for Workspace Agent Hub launch info in $StdOutPath."
}

function Start-WebUiProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [Parameter(Mandatory = $true)]
        [int]$PreferredPort,
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    Ensure-StateDirectory -TargetStatePath $TargetStatePath
    $stateDirectory = Split-Path -Parent $TargetStatePath
    $stdoutPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.stdout.log')
    $stderrPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.stderr.log')

    $shellPath = Get-PowerShellPath
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $startScriptPath,
        '-PhoneReady',
        '-NoOpenBrowser',
        '-JsonOutput',
        '-Port',
        [string]$PreferredPort,
        '-AuthToken',
        $Token
    )
    if (
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL -and
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
    ) {
        $argumentList += @(
            '-PublicUrl',
            $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
        )
    }

    $process = Start-Process -FilePath $shellPath -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Get-ReadyListenerProcessId {
    param(
        [string]$ListenUrl,
        [string]$Token
    )

    if (-not $ListenUrl -or -not $Token) {
        return $null
    }

    if (-not (Wait-ForWebUiReady -ListenUrl $ListenUrl -Token $Token -TimeoutMilliseconds 3000)) {
        return $null
    }

    return (Get-ListenerProcessId -ListenUrl $ListenUrl)
}

function Get-ProcessLaunchDetail {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo
    )

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

    if ($stderrText) {
        return $stderrText
    }
    if ($stdoutText) {
        return $stdoutText
    }

    return 'No process output captured.'
}

$resolvedStatePath = if ($StatePath -and $StatePath.Trim()) { [IO.Path]::GetFullPath($StatePath.Trim()) } else { Get-DefaultStatePath }
$existingState = Read-State -TargetStatePath $resolvedStatePath
$resolvedToken = Get-ResolvedAuthToken -ExistingState $existingState
$existingProcessAlive = Test-ManagedProcessAlive -ExistingState $existingState
$existingListenUrl = if ($existingState -and $existingState.ListenUrl) {
    Get-LocalReachableUrl -ListenUrl ([string]$existingState.ListenUrl)
} else {
    ''
}
$existingListenerProcessId = $null
$canReuseExistingInstance = $false

if (
    $existingState -and
    $existingListenUrl -and
    [string]$existingState.AccessCode -eq $resolvedToken
) {
    $existingListenerProcessId = if ($existingProcessAlive) {
        [int]$existingState.ProcessId
    } else {
        Get-ReadyListenerProcessId -ListenUrl $existingListenUrl -Token $resolvedToken
    }
    $canReuseExistingInstance = if (
        $existingListenerProcessId -and
        (Test-TailscaleServeTargetMatchesListenUrl -ExistingState $existingState -ListenUrl $existingListenUrl)
    ) {
        $true
    } else {
        $false
    }
}

if (
    $canReuseExistingInstance
) {
    $localListenUrl = $existingListenUrl
    $finalState = [pscustomobject]@{
        ListenUrl = $localListenUrl
        PreferredConnectUrl = [string]$existingState.PreferredConnectUrl
        PreferredConnectUrlSource = [string]$existingState.PreferredConnectUrlSource
        AccessCode = [string]$existingState.AccessCode
        OneTapPairingLink = [string]$existingState.OneTapPairingLink
        ProcessId = [int]$existingListenerProcessId
        BrowserUrl = Get-BrowserUrl -ListenUrl $localListenUrl -Token $resolvedToken
        StatePath = $resolvedStatePath
        StdOutPath = [string]$existingState.StdOutPath
        StdErrPath = [string]$existingState.StdErrPath
        UpdatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-State -TargetStatePath $resolvedStatePath -State $finalState
} else {
    $fallbackProcessId = if (
        $existingState -and
        $existingListenUrl -and
        $existingState.AccessCode
    ) {
        Get-ReadyListenerProcessId -ListenUrl $existingListenUrl -Token ([string]$existingState.AccessCode)
    } else {
        $null
    }
    Stop-ManagedProcessIfPresent -ExistingState $existingState -FallbackProcessId $fallbackProcessId
    $started = Start-WebUiProcess -Token $resolvedToken -PreferredPort $Port -TargetStatePath $resolvedStatePath
    $launchInfo = Wait-ForLaunchInfo -StdOutPath $started.StdOutPath
    $localListenUrl = Get-LocalReachableUrl -ListenUrl ([string]$launchInfo.listenUrl)
    $ready = Wait-ForWebUiReady -ListenUrl $localListenUrl -Token $resolvedToken -TimeoutMilliseconds 90000
    if (-not $ready) {
        throw "Workspace Agent Hub web UI did not become ready at $localListenUrl. $(Get-ProcessLaunchDetail -ProcessInfo $started)"
    }
    $actualProcessId = Get-ListenerProcessId -ListenUrl $localListenUrl
    if (-not $actualProcessId) {
        $actualProcessId = [int]$started.Process.Id
    }

    $finalState = [pscustomobject]@{
        ListenUrl = $localListenUrl
        PreferredConnectUrl = [string]$launchInfo.preferredConnectUrl
        PreferredConnectUrlSource = [string]$launchInfo.preferredConnectUrlSource
        AccessCode = [string]$launchInfo.accessCode
        OneTapPairingLink = [string]$launchInfo.oneTapPairingLink
        ProcessId = [int]$actualProcessId
        BrowserUrl = Get-BrowserUrl -ListenUrl $localListenUrl -Token $resolvedToken
        StatePath = $resolvedStatePath
        StdOutPath = $started.StdOutPath
        StdErrPath = $started.StdErrPath
        UpdatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-State -TargetStatePath $resolvedStatePath -State $finalState
}

if ($OpenBrowser) {
    Start-Process -FilePath ([string]$finalState.BrowserUrl) | Out-Null
}

if ($JsonOutput) {
    $finalState | ConvertTo-Json -Depth 8
} else {
    Write-Output ("Workspace Agent Hub ready: {0}" -f [string]$finalState.BrowserUrl)
}
