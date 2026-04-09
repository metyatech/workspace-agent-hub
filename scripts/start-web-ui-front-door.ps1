param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [string]$ListenHost = '127.0.0.1',
    [int]$Port = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')
$sourcePaths = @(
    (Join-Path $repoRoot 'src\cli.ts'),
    (Join-Path $repoRoot 'src\web-ui-front-door.ts')
)

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
    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[start-web-ui-front-door]'
    }

    if (Test-BuildRequired -DistPath $distCliPath -CandidateSourcePaths $sourcePaths) {
        $npmExitCode = Invoke-NpmCommand -Arguments @('run', 'build')
        if ($npmExitCode -ne 0) {
            throw 'npm run build failed.'
        }
    }

    $arguments = @(
        $distCliPath,
        'web-ui-front-door',
        '--state-path', ([IO.Path]::GetFullPath($StatePath)),
        '--host', $ListenHost,
        '--port', [string]$Port
    )

    & node @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        [Console]::Error.WriteLine("Workspace Agent Hub front door exited with code $exitCode.")
        exit $exitCode
    }
} finally {
    Pop-Location
}
