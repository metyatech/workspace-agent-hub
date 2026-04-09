Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-npm-bootstrap-' + [guid]::NewGuid().ToString('N'))
$repoRoot = Join-Path $tempRoot 'repo'

try {
    New-Item -ItemType Directory -Path $repoRoot -Force | Out-Null
    Set-Content -Path (Join-Path $repoRoot 'package.json') -Value @'
{
  "name": "fixture",
  "dependencies": {
    "@metyatech/thread-inbox": "^0.4.2",
    "commander": "^14.0.3",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "@playwright/test": "^1.58.2",
    "jsdom": "^28.1.0",
    "prettier": "^3.8.1",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
'@

    $partialNodeModules = Join-Path $repoRoot 'node_modules\.vite'
    New-Item -ItemType Directory -Path $partialNodeModules -Force | Out-Null

    if (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot) {
        throw 'Expected a partial node_modules surface to fail the readiness probe.'
    }

    $probePaths = Get-NpmDependencyProbePaths -RepoRoot $repoRoot
    $threadInboxProbe = Join-Path $repoRoot 'node_modules\@metyatech\thread-inbox\package.json'
    $playwrightProbe = Join-Path $repoRoot 'node_modules\@playwright\test\package.json'

    if ($probePaths -notcontains $threadInboxProbe) {
        throw 'Expected the readiness probe to include @metyatech/thread-inbox.'
    }

    if ($probePaths -notcontains $playwrightProbe) {
        throw 'Expected the readiness probe to include @playwright/test.'
    }

    foreach ($probePath in $probePaths) {
        if ($probePath -eq $threadInboxProbe) {
            continue
        }

        $probeDirectory = Split-Path -Parent $probePath
        if (-not (Test-Path -Path $probeDirectory)) {
            New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
        }

        Set-Content -Path $probePath -Value 'ok'
    }

    if (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot) {
        throw 'Expected a missing direct dependency package to fail the readiness probe.'
    }

    $threadInboxDirectory = Split-Path -Parent $threadInboxProbe
    if (-not (Test-Path -Path $threadInboxDirectory)) {
        New-Item -ItemType Directory -Path $threadInboxDirectory -Force | Out-Null
    }

    Set-Content -Path $threadInboxProbe -Value 'ok'

    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        throw 'Expected a complete dependency surface to pass the readiness probe.'
    }

    Write-Output 'PASS'
} finally {
    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}
