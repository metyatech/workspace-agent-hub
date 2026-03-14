Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$nodeModulesPath = Join-Path $repoRoot 'node_modules'

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-Path -Path $nodeModulesPath))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }

    if (Test-Path -Path $packageJsonPath) {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run build failed.'
        }
    }

    & compose-agentsmd
} finally {
    Pop-Location
}

Write-Output 'Build OK.'
