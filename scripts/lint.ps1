Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$rulesetPath = Join-Path $repoRoot 'agent-ruleset.json'
$packageJsonPath = Join-Path $repoRoot 'package.json'
$nodeModulesPath = Join-Path $repoRoot 'node_modules'

if (-not (Test-Path -Path $rulesetPath)) {
    Write-Error "Missing ruleset: $rulesetPath"
    exit 1
}

try {
    Get-Content -Path $rulesetPath -Raw | ConvertFrom-Json | Out-Null
} catch {
    Write-Error "Invalid JSON in $rulesetPath"
    exit 1
}

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-Path -Path $nodeModulesPath))) {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw 'npm ci failed.'
        }
    }

    if (Test-Path -Path $packageJsonPath) {
        npm run format:check
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run format:check failed.'
        }

        npm run lint
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run lint failed.'
        }
    }
} finally {
    Pop-Location
}

Write-Output 'Lint OK.'
