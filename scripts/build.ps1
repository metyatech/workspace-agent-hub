Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
$tsConfigPath = Join-Path $repoRoot 'tsconfig.json'

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

function Get-BuildCandidateSourcePaths {
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @(Get-ChildItem -Path (Join-Path $repoRoot 'src') -Recurse -File -Filter '*.ts')) {
        [void]$paths.Add($item.FullName)
    }
    [void]$paths.Add($tsConfigPath)
    return $paths.ToArray()
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
        if (-not $candidatePath -or -not (Test-Path -LiteralPath $candidatePath)) {
            continue
        }

        if ((Get-Item -LiteralPath $candidatePath).LastWriteTimeUtc -gt $distWriteTimeUtc) {
            return $true
        }
    }

    return $false
}

function Test-DistImportable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DistPath
    )

    if (-not (Test-Path -Path $DistPath)) {
        return $false
    }

    $distFileUrl = ([Uri]::new($DistPath)).AbsoluteUri
    & node -e "import('$distFileUrl').catch(()=>process.exit(1))" 2>$null
    return ($LASTEXITCODE -eq 0)
}

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }

    if (Test-Path -Path $packageJsonPath) {
        $buildRequired = Test-BuildRequired -DistPath $distCliPath -CandidateSourcePaths (Get-BuildCandidateSourcePaths)
        if (-not $buildRequired) {
            $buildRequired = -not (Test-DistImportable -DistPath $distCliPath)
        }

        if ($buildRequired) {
            npm run build
            if ($LASTEXITCODE -ne 0) {
                throw 'npm run build failed.'
            }
        }
    }

    if ($env:WORKSPACE_AGENT_HUB_SKIP_COMPOSE -ne '1') {
        & compose-agentsmd
    }
} finally {
    Pop-Location
}

Write-Output 'Build OK.'
