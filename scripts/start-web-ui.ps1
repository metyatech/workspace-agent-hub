param(
    [string]$ListenHost = '127.0.0.1',
    [int]$Port = 3360,
    [string]$AuthToken,
    [string]$PublicUrl,
    [switch]$TailscaleServe,
    [switch]$PhoneReady,
    [switch]$JsonOutput,
    [switch]$NoOpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
$effectiveCliPath = if (
    $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH -and
    $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim()
) {
    [IO.Path]::GetFullPath($env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim())
} else {
    $distCliPath
}

if (-not (Test-Path -Path $packageJsonPath)) {
    throw "Missing package.json: $packageJsonPath"
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -Path (Join-Path $repoRoot 'node_modules'))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }

    if (-not (Test-Path -Path $effectiveCliPath)) {
        if ($effectiveCliPath -ne $distCliPath) {
            throw "Missing CLI entrypoint: $effectiveCliPath"
        }
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run build failed.'
        }
    }

    $resolvedAuthToken = if ($PSBoundParameters.ContainsKey('AuthToken')) {
        $AuthToken
    } elseif ($env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN) {
        $env:WORKSPACE_AGENT_HUB_WEB_UI_AUTH_TOKEN
    } elseif ($PhoneReady) {
        'none'
    } else {
        'auto'
    }

    $resolvedPublicUrl = if ($PSBoundParameters.ContainsKey('PublicUrl')) {
        $PublicUrl
    } elseif ($env:WORKSPACE_AGENT_HUB_WEB_UI_PUBLIC_URL) {
        $env:WORKSPACE_AGENT_HUB_WEB_UI_PUBLIC_URL
    } else {
        ''
    }

    $effectiveListenHost = if (
        $PhoneReady -and
        -not $PSBoundParameters.ContainsKey('ListenHost')
    ) {
        '0.0.0.0'
    } else {
        $ListenHost
    }

    $arguments = @(
        $effectiveCliPath,
        'web-ui',
        '--host', $effectiveListenHost,
        '--port', [string]$Port
    )
    if ($null -ne $resolvedAuthToken -and $resolvedAuthToken -ne '') {
        $arguments += @('--auth-token', $resolvedAuthToken)
    }
    if ($null -ne $resolvedPublicUrl -and $resolvedPublicUrl -ne '') {
        $arguments += @('--public-url', $resolvedPublicUrl)
    }
    if ($TailscaleServe -or $PhoneReady) {
        $arguments += '--tailscale-serve'
    }
    if ($JsonOutput) {
        $arguments += '--json'
    }
    if ($NoOpenBrowser) {
        $arguments += '--no-open-browser'
    }

    & node @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        [Console]::Error.WriteLine("Workspace Agent Hub web UI exited with code $exitCode.")
        exit $exitCode
    }
} finally {
    Pop-Location
}
