Set-StrictMode -Version Latest

function Get-RepoMutationLockName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $normalizedRepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\').ToLowerInvariant()
    $pathBytes = [Text.Encoding]::UTF8.GetBytes($normalizedRepoRoot)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($pathBytes)
    } finally {
        $sha256.Dispose()
    }
    $hashText = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    return ('Global\metyatech-workspace-agent-hub-repo-mutation-' + $hashText)
}

function Invoke-WithRepoMutationLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = 900,
        [string]$ActionDescription = 'repository mutation'
    )

    $mutexName = Get-RepoMutationLockName -RepoRoot $RepoRoot
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    $acquired = $false

    try {
        try {
            $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
        } catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }

        if (-not $acquired) {
            throw "Timed out waiting for the repo mutation lock while running $ActionDescription."
        }

        return (& $ScriptBlock @ArgumentList)
    } finally {
        if ($acquired) {
            try {
                $mutex.ReleaseMutex()
            } catch {
            }
        }
        $mutex.Dispose()
    }
}

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

function Invoke-NpmDependencySurfaceRepair {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [string]$NpmExecutable = 'npm',
        [string]$LogPrefix = '[npm-bootstrap]'
    )

    if (Test-NpmDependencySurfaceReady -RepoRoot $RepoRoot) {
        return
    }

    Invoke-WithRepoMutationLock -RepoRoot $RepoRoot -ActionDescription 'npm dependency repair' -ScriptBlock {
        if (Test-NpmDependencySurfaceReady -RepoRoot $RepoRoot) {
            return
        }

        $repairSteps = @(
            @{
                Label = 'npm ci'
                Arguments = @('ci')
            },
            @{
                Label = 'npm install'
                Arguments = @('install')
            }
        )

        Push-Location $RepoRoot
        try {
            foreach ($repairStep in $repairSteps) {
                & $NpmExecutable @($repairStep.Arguments) 2>&1 | ForEach-Object {
                    if ($_ -is [System.Management.Automation.ErrorRecord]) {
                        [Console]::Error.WriteLine($_.ToString())
                    } else {
                        [Console]::Error.WriteLine([string]$_)
                    }
                }

                if ($LASTEXITCODE -ne 0) {
                    throw "$($repairStep.Label) failed."
                }

                if (Test-NpmDependencySurfaceReady -RepoRoot $RepoRoot) {
                    return
                }

                if ($repairStep.Label -eq 'npm ci') {
                    [Console]::Error.WriteLine("$LogPrefix npm ci left a partial dependency surface; retrying with npm install.")
                }
            }
        } finally {
            Pop-Location
        }

        $missingProbePaths = @(
            Get-NpmDependencyProbePaths -RepoRoot $RepoRoot |
                Where-Object { -not (Test-Path -Path $_) }
        )
        $missingPreview = ($missingProbePaths | Select-Object -First 8) -join ', '
        if (-not $missingPreview) {
            $missingPreview = 'unknown probe paths'
        }

        throw "$LogPrefix npm dependency repair left a partial dependency surface. Missing: $missingPreview"
    }
}
