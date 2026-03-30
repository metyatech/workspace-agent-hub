Set-StrictMode -Version Latest

function Get-NpmDependencyProbePaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $nodeModulesPath = Join-Path $RepoRoot 'node_modules'

    return @(
        Join-Path $nodeModulesPath '.bin\vitest.cmd'
        Join-Path $nodeModulesPath '.bin\playwright.cmd'
        Join-Path $nodeModulesPath '.bin\tsup.cmd'
        Join-Path $nodeModulesPath '.bin\tsc.cmd'
        Join-Path $nodeModulesPath '.bin\prettier.cmd'
        Join-Path $nodeModulesPath 'commander\package.json'
        Join-Path $nodeModulesPath 'jsdom\package.json'
        Join-Path $nodeModulesPath 'qrcode\package.json'
    )
}

function Test-NpmDependencySurfaceReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    foreach ($probePath in (Get-NpmDependencyProbePaths -RepoRoot $RepoRoot)) {
        if (-not (Test-Path -Path $probePath)) {
            return $false
        }
    }

    return $true
}
