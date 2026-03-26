param(
    [string]$ListenHost = '127.0.0.1',
    [int]$Port = 3360,
    [string]$AuthToken,
    [string]$PublicUrl,
    [switch]$TailscaleServe,
    [switch]$DisableTailscaleServe,
    [switch]$PhoneReady,
    [switch]$JsonOutput,
    [switch]$NoOpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
$sourcePaths = @(
    (Join-Path $repoRoot 'src\cli.ts'),
    (Join-Path $repoRoot 'src\web-ui.ts'),
    (Join-Path $repoRoot 'src\manager-app.ts'),
    (Join-Path $repoRoot 'src\web-app.ts')
)
$effectiveCliPath = if (
    $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH -and
    $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim()
) {
    [IO.Path]::GetFullPath($env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH.Trim())
} else {
    $distCliPath
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

if (-not (Test-Path -Path $packageJsonPath)) {
    throw "Missing package.json: $packageJsonPath"
}

Push-Location $repoRoot
try {
    $nodeModulesOk = $false
    if (Test-Path -Path (Join-Path $repoRoot 'node_modules')) {
        # Verify node_modules integrity by importing a critical dependency
        & node -e "require('commander')" 2>$null
        $nodeModulesOk = ($LASTEXITCODE -eq 0)
        if (-not $nodeModulesOk) {
            [Console]::Error.WriteLine('[start-web-ui] node_modules integrity check failed; auto-repairing via npm ci.')
        }
    }
    if (-not $nodeModulesOk) {
        $npmExitCode = Invoke-NpmCommand -Arguments @('ci')
        if ($npmExitCode -ne 0) {
            throw 'npm ci failed.'
        }
    }

    $buildNeeded = $false
    if ($effectiveCliPath -eq $distCliPath -and (Test-BuildRequired -DistPath $distCliPath -CandidateSourcePaths $sourcePaths)) {
        $buildNeeded = $true
    } elseif (-not (Test-Path -Path $effectiveCliPath)) {
        if ($effectiveCliPath -ne $distCliPath) {
            throw "Missing CLI entrypoint: $effectiveCliPath"
        }
        $buildNeeded = $true
    }

    # Even if timestamps look fresh, verify the dist can actually be imported
    if (-not $buildNeeded -and (Test-Path -Path $effectiveCliPath)) {
        $distFileUrl = ([Uri]::new($effectiveCliPath)).AbsoluteUri
        & node -e "import('$distFileUrl').catch(()=>process.exit(1))" 2>$null
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine('[start-web-ui] dist integrity check failed; auto-repairing via rebuild.')
            $buildNeeded = $true
        }
    }

    if ($buildNeeded) {
        $npmExitCode = Invoke-NpmCommand -Arguments @('run', 'build')
        if ($npmExitCode -ne 0) {
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
    if (($TailscaleServe -or $PhoneReady) -and -not $DisableTailscaleServe) {
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
