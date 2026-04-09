Set-StrictMode -Version Latest

function Get-NpmDirectDependencyPackageNames {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $packageJsonPath = Join-Path $RepoRoot 'package.json'
    if (-not (Test-Path -Path $packageJsonPath)) {
        return @()
    }

    $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
    $packageNames = [System.Collections.Generic.List[string]]::new()

    foreach ($fieldName in @('dependencies', 'devDependencies')) {
        $field = $packageJson.$fieldName
        if ($null -ne $field) {
            foreach ($property in ($field.PSObject.Properties | Sort-Object -Property Name)) {
                $packageNames.Add([string]$property.Name)
            }
        }
    }

    return $packageNames | Sort-Object -Unique
}

function Get-NpmDependencyProbePaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $nodeModulesPath = Join-Path $RepoRoot 'node_modules'
    $probePaths = [System.Collections.Generic.List[string]]::new()

    foreach ($probePath in @(
            Join-Path $nodeModulesPath '.bin\vitest.cmd'
            Join-Path $nodeModulesPath '.bin\playwright.cmd'
            Join-Path $nodeModulesPath '.bin\tsup.cmd'
            Join-Path $nodeModulesPath '.bin\tsc.cmd'
            Join-Path $nodeModulesPath '.bin\prettier.cmd'
        )) {
        $probePaths.Add($probePath)
    }

    foreach ($packageName in (Get-NpmDirectDependencyPackageNames -RepoRoot $RepoRoot)) {
        $normalizedPackagePath = $packageName.Replace('/', '\')
        $probePaths.Add((Join-Path $nodeModulesPath (Join-Path $normalizedPackagePath 'package.json')))
    }

    return $probePaths
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
