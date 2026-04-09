Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distCliPath = Join-Path $repoRoot 'dist\cli.js'
$tsConfigPath = Join-Path $repoRoot 'tsconfig.json'

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')
. (Join-Path $PSScriptRoot 'build-command.ps1')

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
    if (Test-Path -Path $packageJsonPath) {
        Invoke-WithRepoMutationLock -RepoRoot $repoRoot -ActionDescription 'build script bootstrap' -ScriptBlock {
            if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
                Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[build]'
            }

            $buildRequired = Test-BuildRequired -DistPath $distCliPath -CandidateSourcePaths (Get-BuildCandidateSourcePaths)
            if (-not $buildRequired) {
                $buildRequired = -not (Test-DistImportable -DistPath $distCliPath)
            }

            if ($buildRequired) {
                Invoke-WorkspaceAgentHubBuildCommand -RepoRoot $repoRoot
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
