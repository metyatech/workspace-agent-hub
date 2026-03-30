Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-npm-bootstrap-' + [guid]::NewGuid().ToString('N'))
$repoRoot = Join-Path $tempRoot 'repo'

try {
    New-Item -ItemType Directory -Path $repoRoot -Force | Out-Null
    Set-Content -Path (Join-Path $repoRoot 'package.json') -Value '{"name":"fixture"}'

    $partialNodeModules = Join-Path $repoRoot 'node_modules\.vite'
    New-Item -ItemType Directory -Path $partialNodeModules -Force | Out-Null

    if (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot) {
        throw 'Expected a partial node_modules surface to fail the readiness probe.'
    }

    foreach ($probePath in (Get-NpmDependencyProbePaths -RepoRoot $repoRoot)) {
        $probeDirectory = Split-Path -Parent $probePath
        if (-not (Test-Path -Path $probeDirectory)) {
            New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
        }

        Set-Content -Path $probePath -Value 'ok'
    }

    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        throw 'Expected a complete dependency surface to pass the readiness probe.'
    }

    Write-Output 'PASS'
} finally {
    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}
