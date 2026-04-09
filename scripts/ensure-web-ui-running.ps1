param(
    [int]$Port = 3360,
    [string]$AuthToken = '',
    [string]$StatePath = '',
    [switch]$PhoneReady,
    [switch]$OpenBrowser,
    [switch]$JsonOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')
if (-not (Test-Path -Path $packageJsonPath)) {
    throw "Missing package.json: $packageJsonPath"
}

function Get-BuildSourcePaths {
    $paths = [System.Collections.Generic.List[string]]::new()

    foreach ($fixedPath in @(
        $packageJsonPath,
        (Join-Path $repoRoot 'tsconfig.json'),
        (Join-Path $repoRoot 'tsup.config.ts')
    )) {
        if (Test-Path -LiteralPath $fixedPath) {
            $paths.Add((Resolve-Path $fixedPath).Path)
        }
    }

    foreach ($relativeDir in @('src', 'public')) {
        $sourceRoot = Join-Path $repoRoot $relativeDir
        if (-not (Test-Path -LiteralPath $sourceRoot)) {
            continue
        }
        foreach ($candidate in (Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)) {
            $paths.Add($candidate.FullName)
        }
    }

    return $paths.ToArray()
}

$buildSourcePaths = Get-BuildSourcePaths

function Get-DefaultStatePath {
    $stateDirectory = Join-Path $env:USERPROFILE 'agent-handoff'
    return (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.json')
}

function Test-BuildRequired {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DistPath,
        [Parameter(Mandatory = $true)]
        [string[]]$CandidateSourcePaths
    )

    if (-not (Test-Path -Path $DistPath)) {
        return $true
    }

    $distWriteTimeUtc = (Get-Item -LiteralPath $DistPath).LastWriteTimeUtc
    foreach ($candidatePath in $CandidateSourcePaths) {
        if (-not (Test-Path -LiteralPath $candidatePath)) {
            continue
        }
        if ((Get-Item -LiteralPath $candidatePath).LastWriteTimeUtc -gt $distWriteTimeUtc) {
            return $true
        }
    }

    return $false
}

function Invoke-NpmCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & npm @Arguments 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
            [Console]::Error.WriteLine($_.ToString())
        } else {
            [Console]::Error.WriteLine([string]$_)
        }
    }

    return $LASTEXITCODE
}

function Ensure-WorkspaceCliReady {
    param(
        [switch]$AllowTestCliOverride
    )

    $effectiveCliPath = if (
        $AllowTestCliOverride -and
        $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH -and
        $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim()
    ) {
        [IO.Path]::GetFullPath($env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim())
    } else {
        $distCliPath
    }

    Push-Location $repoRoot
    try {
        if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
            Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[ensure-web-ui-running]'
        }

        if ($effectiveCliPath -eq $distCliPath -and (Test-BuildRequired -DistPath $distCliPath -CandidateSourcePaths $buildSourcePaths)) {
            $npmExitCode = Invoke-NpmCommand -Arguments @('run', 'build')
            if ($npmExitCode -ne 0) {
                throw 'npm run build failed.'
            }
        } elseif (-not (Test-Path -Path $effectiveCliPath)) {
            if ($effectiveCliPath -ne $distCliPath) {
                throw "Missing CLI entrypoint: $effectiveCliPath"
            }
            $npmExitCode = Invoke-NpmCommand -Arguments @('run', 'build')
            if ($npmExitCode -ne 0) {
                throw 'npm run build failed.'
            }
        }
    } finally {
        Pop-Location
    }

    return $effectiveCliPath
}

function Start-NodeCliProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$StdOutPath,
        [Parameter(Mandatory = $true)]
        [string]$StdErrPath
    )

    $nodePath = (Get-Command 'node.exe' -ErrorAction Stop).Source
    $process = Start-Process `
        -FilePath $nodePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $StdOutPath `
        -RedirectStandardError $StdErrPath
    return $process
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

function Test-AuthTokenOptionDisablesAuth {
    param(
        [string]$TokenOption
    )

    if (-not $TokenOption) {
        return $false
    }

    return ($TokenOption.Trim().ToLowerInvariant() -eq 'none')
}

function Get-EffectiveAccessCode {
    param(
        [string]$TokenOption
    )

    if (Test-AuthTokenOptionDisablesAuth -TokenOption $TokenOption) {
        return ''
    }

    if ($TokenOption -and $TokenOption.Trim()) {
        return $TokenOption.Trim()
    }

    return ''
}

function Get-StateAccessCodeValue {
    param(
        $State
    )

    if (-not $State) {
        return $null
    }

    if (
        $State.PSObject.Properties.Match('AuthDisabled').Count -gt 0 -and
        [bool]$State.AuthDisabled
    ) {
        return $null
    }

    if (
        $State.PSObject.Properties.Match('AccessCode').Count -gt 0 -and
        $null -ne $State.AccessCode -and
        [string]$State.AccessCode -ne ''
    ) {
        return [string]$State.AccessCode
    }

    return $null
}

function Get-ResolvedAuthToken {
    param(
        $ExistingState,
        [bool]$RequestedPhoneReady
    )

    if ($AuthToken -and $AuthToken.Trim()) {
        return $AuthToken.Trim()
    }

    if ($env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN) {
        return ([string]$env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN).Trim()
    }

    if ($RequestedPhoneReady) {
        return 'none'
    }

    $existingAccessCode = Get-StateAccessCodeValue -State $ExistingState
    if ($existingAccessCode) {
        return $existingAccessCode
    }

    return (New-AccessCode)
}

function Test-RequestedAuthMatches {
    param(
        $ExistingState,
        [string]$RequestedTokenOption
    )

    $requestedAuthDisabled = Test-AuthTokenOptionDisablesAuth -TokenOption $RequestedTokenOption
    $existingAccessCode = Get-StateAccessCodeValue -State $ExistingState
    $existingAuthDisabled = if (
        $ExistingState -and
        $ExistingState.PSObject.Properties.Match('AuthDisabled').Count -gt 0
    ) {
        [bool]$ExistingState.AuthDisabled
    } else {
        $false
    }

    if ($requestedAuthDisabled -ne $existingAuthDisabled) {
        return $false
    }

    if ($requestedAuthDisabled) {
        return $true
    }

    return ($existingAccessCode -eq (Get-EffectiveAccessCode -TokenOption $RequestedTokenOption))
}

function Test-RequestedPhoneReadyMatches {
    param(
        $ExistingState,
        [bool]$RequestedPhoneReady
    )

    $existingPhoneReady = $false
    if (
        $ExistingState -and
        $ExistingState.PSObject.Properties.Match('RequestedPhoneReady').Count -gt 0 -and
        $null -ne $ExistingState.RequestedPhoneReady
    ) {
        $existingPhoneReady = [bool]$ExistingState.RequestedPhoneReady
    }

    return ($existingPhoneReady -eq $RequestedPhoneReady)
}

function Test-StatePackageRootMatches {
    param(
        $ExistingState
    )

    if (
        -not $ExistingState -or
        $ExistingState.PSObject.Properties.Match('PackageRoot').Count -eq 0 -or
        -not $ExistingState.PackageRoot
    ) {
        return $false
    }

    try {
        $existingPackageRoot = [IO.Path]::GetFullPath([string]$ExistingState.PackageRoot)
    } catch {
        return $false
    }

    return ($existingPackageRoot.TrimEnd('\').ToLowerInvariant() -eq $repoRoot.Path.TrimEnd('\').ToLowerInvariant())
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
    $effectiveAccessCode = Get-EffectiveAccessCode -TokenOption $Token
    if ($effectiveAccessCode) {
        $builder.Fragment = 'accessCode=' + [Uri]::EscapeDataString($effectiveAccessCode)
    } else {
        $builder.Fragment = ''
    }
    return $builder.Uri.AbsoluteUri
}

function Get-StateString {
    param(
        $State,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    if (
        -not $State -or
        $State.PSObject.Properties.Match($PropertyName).Count -eq 0 -or
        $null -eq $State.$PropertyName
    ) {
        return ''
    }

    return ([string]$State.$PropertyName).Trim()
}

function Get-StateInt {
    param(
        $State,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    $raw = Get-StateString -State $State -PropertyName $PropertyName
    if (-not $raw) {
        return $null
    }

    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed)) {
        return $parsed
    }

    return $null
}

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Test-TcpPortListening {
    param(
        [int]$PortNumber
    )

    if ($PortNumber -le 0) {
        return $false
    }

    $connectAsync = $null
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connectAsync = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if (-not $connectAsync.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connectAsync)
        return $true
    } catch {
        return $false
    } finally {
        if ($connectAsync -and $connectAsync.AsyncWaitHandle) {
            $connectAsync.AsyncWaitHandle.Close()
        }
        $client.Dispose()
    }
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
        $expectedProxyUrl = Get-FrontDoorListenUrl -State $ExistingState
        if (-not $expectedProxyUrl) {
            $expectedProxyUrl = $ListenUrl
        }
        $listenUri = [Uri]$expectedProxyUrl
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
        $effectiveAccessCode = Get-EffectiveAccessCode -TokenOption $Token
        if ($effectiveAccessCode) {
            $headers['X-Workspace-Agent-Hub-Token'] = $effectiveAccessCode
        }
        $response = Invoke-WebRequest -Uri ($ListenUrl.TrimEnd('/') + '/api/sessions?includeArchived=true') -Method Get -Headers $headers -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Test-ManagerHealthy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl,
        [Parameter(Mandatory = $true)]
        [string]$Token
    )

    try {
        $headers = @{}
        $effectiveAccessCode = Get-EffectiveAccessCode -TokenOption $Token
        if ($effectiveAccessCode) {
            $headers['X-Workspace-Agent-Hub-Token'] = $effectiveAccessCode
        }
        $response = Invoke-WebRequest -Uri ($ListenUrl.TrimEnd('/') + '/manager/api/manager/status') -Method Get -Headers $headers -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
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

function Test-ProcessAliveById {
    param(
        [int]$ProcessId
    )

    if ($ProcessId -le 0) {
        return $false
    }

    try {
        [void](Get-Process -Id $ProcessId -ErrorAction Stop)
        return $true
    } catch {
        return $false
    }
}

function Get-FrontDoorListenUrl {
    param(
        $State
    )

    return (Get-StateString -State $State -PropertyName 'FrontDoorListenUrl')
}

function Get-FrontDoorProcessId {
    param(
        $State
    )

    return (Get-StateInt -State $State -PropertyName 'FrontDoorProcessId')
}

function Test-FrontDoorReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl
    )

    try {
        $response = Invoke-WebRequest -Uri ($ListenUrl.TrimEnd('/') + '/api/front-door/health') -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return ($response.StatusCode -eq 200 -or $response.StatusCode -eq 503)
    } catch {
        if (
            $null -ne $_.Exception.Response -and
            $null -ne $_.Exception.Response.StatusCode -and
            [int]$_.Exception.Response.StatusCode -eq 503
        ) {
            return $true
        }
        return $false
    }
}

function Wait-ForFrontDoorReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ListenUrl,
        [int]$TimeoutMilliseconds = 30000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (Test-FrontDoorReady -ListenUrl $ListenUrl) {
            return $true
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

function Get-TailscaleDnsName {
    if (
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_DNS_NAME -and
        $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_DNS_NAME.Trim()
    ) {
        return $env:WORKSPACE_AGENT_HUB_TEST_TAILSCALE_DNS_NAME.Trim().TrimEnd('.')
    }

    try {
        $statusJson = (& tailscale status --json 2>&1 | Out-String)
        if (-not $statusJson.Trim()) {
            return ''
        }
        $status = $statusJson | ConvertFrom-Json
        if (
            $status -and
            $status.PSObject.Properties.Match('Self').Count -gt 0 -and
            $status.Self -and
            $status.Self.PSObject.Properties.Match('DNSName').Count -gt 0 -and
            $status.Self.DNSName
        ) {
            return ([string]$status.Self.DNSName).Trim().TrimEnd('.')
        }
    } catch {
    }

    return ''
}

function Test-UrlReachable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Ensure-TailscaleServeTarget {
    param(
        [Parameter(Mandatory = $true)]
        [int]$FrontDoorPort
    )

    $dnsName = Get-TailscaleDnsName
    if (-not $dnsName) {
        return [pscustomobject]@{
            PreferredConnectUrl = ''
            PreferredConnectUrlSource = 'listen-url'
            OneTapPairingLink = ''
        }
    }

    $directConnectUrl = "http://${dnsName}:$FrontDoorPort"
    $secureConnectUrl = "https://$dnsName"

    $serveHealthy = $false
    if (
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL -and
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
    ) {
        $serveHealthy = $true
        $secureConnectUrl = $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
    } else {
        try {
            & tailscale serve --bg --yes "http://127.0.0.1:$FrontDoorPort" | Out-Null
            $serveHealthy = Test-UrlReachable -Url $secureConnectUrl
        } catch {
            $serveHealthy = $false
        }
    }

    return [pscustomobject]@{
        PreferredConnectUrl = if ($serveHealthy) { $secureConnectUrl } else { $directConnectUrl }
        PreferredConnectUrlSource = if ($serveHealthy) { 'tailscale-serve' } else { 'tailscale-direct' }
        OneTapPairingLink = if ($serveHealthy) { $secureConnectUrl } else { $directConnectUrl }
    }
}

function Stop-ManagedProcessIfPresent {
    param(
        $ExistingState,
        [int]$FallbackProcessId = 0,
        [int[]]$ExcludeProcessIds = @()
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
        if ($ExcludeProcessIds -contains $candidateProcessId) {
            continue
        }
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

function Try-ParseLastJsonLine {
    param(
        [string]$RawText
    )

    if ($null -eq $RawText) {
        return $null
    }

    $trimmedText = $RawText.Trim()
    if (-not $trimmedText) {
        return $null
    }

    $lines = $trimmedText -split "\r?\n"
    for ($index = $lines.Length - 1; $index -ge 0; $index -= 1) {
        $candidate = $lines[$index].Trim()
        if (-not $candidate) {
            continue
        }
        try {
            return ($candidate | ConvertFrom-Json)
        } catch {
        }
    }

    return $null
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
            $parsed = Try-ParseLastJsonLine -RawText $raw
            if ($parsed) {
                return $parsed
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
        [bool]$RequestedPhoneReady,
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath,
        [string]$PublicUrl = '',
        [switch]$DisableTailscaleServe
    )

    Ensure-StateDirectory -TargetStatePath $TargetStatePath
    $stateDirectory = Split-Path -Parent $TargetStatePath
    $stdoutPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.stdout.log')
    $stderrPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.stderr.log')
    $effectiveCliPath = Ensure-WorkspaceCliReady -AllowTestCliOverride
    $argumentList = @(
        $effectiveCliPath,
        'web-ui',
        '--host',
        '0.0.0.0',
        '--port',
        [string]$PreferredPort,
        '--auth-token',
        $Token,
        '--json',
        '--no-open-browser'
    )
    $effectivePublicUrl = if ($PublicUrl -and $PublicUrl.Trim()) {
        $PublicUrl.Trim()
    } elseif (
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL -and
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
    ) {
        $env:WORKSPACE_AGENT_HUB_TEST_PUBLIC_URL.Trim()
    } else {
        ''
    }
    if ($effectivePublicUrl) {
        $argumentList += @(
            '--public-url',
            $effectivePublicUrl
        )
    }
    if (-not $DisableTailscaleServe) {
        $argumentList += '--tailscale-serve'
    }

    $process = Start-NodeCliProcess -ArgumentList $argumentList -StdOutPath $stdoutPath -StdErrPath $stderrPath
    return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Start-WebUiFrontDoorProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath,
        [Parameter(Mandatory = $true)]
        [int]$PreferredPort
    )

    Ensure-StateDirectory -TargetStatePath $TargetStatePath
    $stateDirectory = Split-Path -Parent $TargetStatePath
    $stdoutPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-front-door.stdout.log')
    $stderrPath = Resolve-LogPath -CandidatePath (Join-Path $stateDirectory 'workspace-agent-hub-front-door.stderr.log')
    $frontDoorCliPath = Ensure-WorkspaceCliReady
    $argumentList = @(
        $frontDoorCliPath,
        'web-ui-front-door',
        '--state-path',
        ([IO.Path]::GetFullPath($TargetStatePath)),
        '--host',
        '127.0.0.1',
        '--port',
        [string]$PreferredPort
    )

    $process = Start-NodeCliProcess -ArgumentList $argumentList -StdOutPath $stdoutPath -StdErrPath $stderrPath
    return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Wait-ForFrontDoorLaunchInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StdOutPath,
        [int]$TimeoutSeconds = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -Path $StdOutPath) {
            $raw = Get-Content -Path $StdOutPath -Raw -Encoding utf8
            $parsed = Try-ParseLastJsonLine -RawText $raw
            if ($parsed) {
                return $parsed
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for Workspace Agent Hub front door launch info in $StdOutPath."
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

function Build-StateFromLaunchInfo {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$LaunchInfo,
        [Parameter(Mandatory = $true)]
        [string]$LocalListenUrl,
        [Parameter(Mandatory = $true)]
        [string]$ResolvedToken,
        [Parameter(Mandatory = $true)]
        [string]$ResolvedStatePath,
        [Parameter(Mandatory = $true)]
        [bool]$RequestedPhoneReady,
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [string]$FrontDoorListenUrl = '',
        [int]$FrontDoorProcessId = 0,
        [string]$FrontDoorStdOutPath = '',
        [string]$FrontDoorStdErrPath = '',
        [string]$PreferredConnectUrl = '',
        [string]$PreferredConnectUrlSource = '',
        [string]$StdOutPath = '',
        [string]$StdErrPath = ''
    )

    $effectivePreferredConnectUrl = if ($PreferredConnectUrl -and $PreferredConnectUrl.Trim()) {
        $PreferredConnectUrl.Trim()
    } else {
        [string]$LaunchInfo.preferredConnectUrl
    }
    $effectivePreferredConnectUrlSource = if ($PreferredConnectUrlSource -and $PreferredConnectUrlSource.Trim()) {
        $PreferredConnectUrlSource.Trim()
    } else {
        [string]$LaunchInfo.preferredConnectUrlSource
    }
    $effectiveBrowserListenUrl = if ($FrontDoorListenUrl -and $FrontDoorListenUrl.Trim()) {
        $FrontDoorListenUrl.Trim()
    } else {
        $LocalListenUrl
    }

    return [pscustomobject]@{
        PackageRoot = $repoRoot.Path
        ListenUrl = $LocalListenUrl
        FrontDoorListenUrl = if ($FrontDoorListenUrl -and $FrontDoorListenUrl.Trim()) { $FrontDoorListenUrl.Trim() } else { $null }
        FrontDoorProcessId = if ($FrontDoorProcessId -gt 0) { [int]$FrontDoorProcessId } else { $null }
        FrontDoorStdOutPath = if ($FrontDoorStdOutPath -and $FrontDoorStdOutPath.Trim()) { $FrontDoorStdOutPath.Trim() } else { $null }
        FrontDoorStdErrPath = if ($FrontDoorStdErrPath -and $FrontDoorStdErrPath.Trim()) { $FrontDoorStdErrPath.Trim() } else { $null }
        PreferredConnectUrl = $effectivePreferredConnectUrl
        PreferredConnectUrlSource = $effectivePreferredConnectUrlSource
        AccessCode = if ([bool]$LaunchInfo.authRequired) { [string]$LaunchInfo.accessCode } else { $null }
        AuthDisabled = -not [bool]$LaunchInfo.authRequired
        OneTapPairingLink = if ($effectivePreferredConnectUrl) { $effectivePreferredConnectUrl } else { [string]$LaunchInfo.oneTapPairingLink }
        ProcessId = [int]$ProcessId
        BrowserUrl = Get-BrowserUrl -ListenUrl $effectiveBrowserListenUrl -Token $ResolvedToken
        StatePath = $ResolvedStatePath
        RequestedPhoneReady = $RequestedPhoneReady
        StdOutPath = $StdOutPath
        StdErrPath = $StdErrPath
        UpdatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Resolve-FrontDoorPort {
    param(
        $ExistingState
    )

    $existingFrontDoorListenUrl = Get-FrontDoorListenUrl -State $ExistingState
    if ($existingFrontDoorListenUrl) {
        try {
            $candidatePort = ([Uri]$existingFrontDoorListenUrl).Port
            if (-not (Test-TcpPortListening -PortNumber $candidatePort)) {
                return $candidatePort
            }
        } catch {
        }
    }

    $statusText = Get-TailscaleServeStatusText
    if ($statusText) {
        $proxyTarget = Get-TailscaleServeProxyTarget -StatusText $statusText
        if ($proxyTarget) {
            try {
                $proxyUri = [Uri]$proxyTarget
                if ($proxyUri.Scheme -eq 'http') {
                    $candidatePort = $proxyUri.Port
                    if (-not (Test-TcpPortListening -PortNumber $candidatePort)) {
                        return $candidatePort
                    }
                }
            } catch {
            }
        }
    }

    return (Get-FreeTcpPort)
}

function Ensure-FrontDoorRunning {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath,
        $ExistingState
    )

    $existingFrontDoorListenUrl = Get-FrontDoorListenUrl -State $ExistingState
    $existingFrontDoorProcessId = Get-FrontDoorProcessId -State $ExistingState
    if (
        (Test-StatePackageRootMatches -ExistingState $ExistingState) -and
        $existingFrontDoorListenUrl -and
        $existingFrontDoorProcessId -and
        (Test-ProcessAliveById -ProcessId $existingFrontDoorProcessId) -and
        (Wait-ForFrontDoorReady -ListenUrl $existingFrontDoorListenUrl -TimeoutMilliseconds 3000)
    ) {
        return [pscustomobject]@{
            ListenUrl = $existingFrontDoorListenUrl
            ProcessId = $existingFrontDoorProcessId
            StdOutPath = Get-StateString -State $ExistingState -PropertyName 'FrontDoorStdOutPath'
            StdErrPath = Get-StateString -State $ExistingState -PropertyName 'FrontDoorStdErrPath'
        }
    }

    if ($existingFrontDoorProcessId -and (Test-ProcessAliveById -ProcessId $existingFrontDoorProcessId)) {
        try {
            Stop-Process -Id $existingFrontDoorProcessId -Force -ErrorAction Stop
        } catch {
        }
    }

    $frontDoorPort = Resolve-FrontDoorPort -ExistingState $ExistingState
    $started = Start-WebUiFrontDoorProcess -TargetStatePath $TargetStatePath -PreferredPort $frontDoorPort
    $launchInfo = Wait-ForFrontDoorLaunchInfo -StdOutPath $started.StdOutPath
    $frontDoorListenUrl = Get-LocalReachableUrl -ListenUrl ([string]$launchInfo.listenUrl)
    if (-not (Wait-ForFrontDoorReady -ListenUrl $frontDoorListenUrl -TimeoutMilliseconds 30000)) {
        throw "Workspace Agent Hub front door did not become ready at $frontDoorListenUrl."
    }

    return [pscustomobject]@{
        ListenUrl = $frontDoorListenUrl
        ProcessId = [int]$started.Process.Id
        StdOutPath = $started.StdOutPath
        StdErrPath = $started.StdErrPath
    }
}

$requestedPhoneReady = $true
$resolvedStatePath = if ($StatePath -and $StatePath.Trim()) { [IO.Path]::GetFullPath($StatePath.Trim()) } else { Get-DefaultStatePath }
$existingState = Read-State -TargetStatePath $resolvedStatePath
$resolvedToken = Get-ResolvedAuthToken -ExistingState $existingState -RequestedPhoneReady $requestedPhoneReady
$frontDoorInfo = Ensure-FrontDoorRunning -TargetStatePath $resolvedStatePath -ExistingState $existingState
$frontDoorPort = ([Uri]$frontDoorInfo.ListenUrl).Port
$preferredPhoneReadyConnectInfo = Ensure-TailscaleServeTarget -FrontDoorPort $frontDoorPort
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
    (Test-StatePackageRootMatches -ExistingState $existingState) -and
    $existingListenUrl -and
    (Test-RequestedAuthMatches -ExistingState $existingState -RequestedTokenOption $resolvedToken) -and
    (Test-RequestedPhoneReadyMatches -ExistingState $existingState -RequestedPhoneReady $requestedPhoneReady) -and
    (Wait-ForFrontDoorReady -ListenUrl $frontDoorInfo.ListenUrl -TimeoutMilliseconds 3000) -and
    (Test-ManagerHealthy -ListenUrl $existingListenUrl -Token $resolvedToken)
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
    $reusedAccessCode = Get-StateAccessCodeValue -State $existingState
    $reusedAuthDisabled = if (
        $existingState -and
        $existingState.PSObject.Properties.Match('AuthDisabled').Count -gt 0
    ) {
        [bool]$existingState.AuthDisabled
    } else {
        $false
    }
    $finalState = [pscustomobject]@{
        PackageRoot = $repoRoot.Path
        ListenUrl = $localListenUrl
        FrontDoorListenUrl = [string]$frontDoorInfo.ListenUrl
        FrontDoorProcessId = [int]$frontDoorInfo.ProcessId
        FrontDoorStdOutPath = [string]$frontDoorInfo.StdOutPath
        FrontDoorStdErrPath = [string]$frontDoorInfo.StdErrPath
        PreferredConnectUrl = if ($preferredPhoneReadyConnectInfo.PreferredConnectUrl) { [string]$preferredPhoneReadyConnectInfo.PreferredConnectUrl } else { [string]$existingState.PreferredConnectUrl }
        PreferredConnectUrlSource = if ($preferredPhoneReadyConnectInfo.PreferredConnectUrlSource) { [string]$preferredPhoneReadyConnectInfo.PreferredConnectUrlSource } else { [string]$existingState.PreferredConnectUrlSource }
        AccessCode = $reusedAccessCode
        AuthDisabled = $reusedAuthDisabled
        OneTapPairingLink = if ($preferredPhoneReadyConnectInfo.OneTapPairingLink) { [string]$preferredPhoneReadyConnectInfo.OneTapPairingLink } else { [string]$existingState.OneTapPairingLink }
        ProcessId = [int]$existingListenerProcessId
        BrowserUrl = Get-BrowserUrl -ListenUrl ([string]$frontDoorInfo.ListenUrl) -Token $resolvedToken
        StatePath = $resolvedStatePath
        RequestedPhoneReady = $requestedPhoneReady
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
    $started = Start-WebUiProcess `
        -Token $resolvedToken `
        -PreferredPort $Port `
        -RequestedPhoneReady $requestedPhoneReady `
        -TargetStatePath $resolvedStatePath `
        -PublicUrl ([string]$preferredPhoneReadyConnectInfo.PreferredConnectUrl) `
        -DisableTailscaleServe
    try {
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

        $finalState = Build-StateFromLaunchInfo `
            -LaunchInfo $launchInfo `
            -LocalListenUrl $localListenUrl `
            -ResolvedToken $resolvedToken `
            -ResolvedStatePath $resolvedStatePath `
            -RequestedPhoneReady $requestedPhoneReady `
            -ProcessId $actualProcessId `
            -FrontDoorListenUrl ([string]$frontDoorInfo.ListenUrl) `
            -FrontDoorProcessId ([int]$frontDoorInfo.ProcessId) `
            -FrontDoorStdOutPath ([string]$frontDoorInfo.StdOutPath) `
            -FrontDoorStdErrPath ([string]$frontDoorInfo.StdErrPath) `
            -PreferredConnectUrl ([string]$preferredPhoneReadyConnectInfo.PreferredConnectUrl) `
            -PreferredConnectUrlSource ([string]$preferredPhoneReadyConnectInfo.PreferredConnectUrlSource) `
            -StdOutPath $started.StdOutPath `
            -StdErrPath $started.StdErrPath
        Write-State -TargetStatePath $resolvedStatePath -State $finalState
    } catch {
        Stop-ManagedProcessIfPresent `
            -ExistingState $null `
            -FallbackProcessId ([int]$started.Process.Id)
        throw
    }

    Stop-ManagedProcessIfPresent `
        -ExistingState $existingState `
        -FallbackProcessId $fallbackProcessId `
        -ExcludeProcessIds @([int]$finalState.ProcessId, [int]$frontDoorInfo.ProcessId)
}

if ($OpenBrowser) {
    Start-Process -FilePath ([string]$finalState.BrowserUrl) | Out-Null
}

if ($JsonOutput) {
    $finalState | ConvertTo-Json -Depth 8
} else {
    Write-Output ("Workspace Agent Hub ready: {0}" -f [string]$finalState.BrowserUrl)
}
