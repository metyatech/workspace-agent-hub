param(
    [string]$Distro = 'Ubuntu',
    [string]$SourcePath = '',
    [string]$TargetPath = '',
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $normalizedPath = $WindowsPath -replace '\\', '/'
    $output = & wsl.exe -d $TargetDistro -- wslpath -a -u $normalizedPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to convert Windows path to WSL path: $WindowsPath"
    }

    return (($output | Out-String).Trim())
}

function Get-WslHomeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $output = & wsl.exe -d $TargetDistro -- printenv HOME
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve HOME inside WSL distro '$TargetDistro'."
    }

    $homePath = (($output | Out-String).Trim())
    if (-not $homePath) {
        throw "WSL distro '$TargetDistro' returned an empty HOME path."
    }

    return $homePath
}

$resolvedSourcePath = if ($SourcePath -and $SourcePath.Trim()) {
    $SourcePath.Trim()
} elseif ($env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE -and $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE.Trim()) {
    $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_SOURCE.Trim()
} else {
    Join-Path $env:USERPROFILE '.codex\auth.json'
}

$resolvedTargetPath = if ($TargetPath -and $TargetPath.Trim()) {
    $TargetPath.Trim()
} elseif ($env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET -and $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET.Trim()) {
    $env:WORKSPACE_AGENT_HUB_CODEX_AUTH_TARGET.Trim()
} else {
    ''
}

if (-not (Test-Path -Path $resolvedSourcePath -PathType Leaf)) {
    $result = [pscustomobject]@{
        Synced = $false
        Reason = 'source-missing'
        SourcePath = $resolvedSourcePath
        TargetPath = if ($resolvedTargetPath) { $resolvedTargetPath } else { '$HOME/.codex/auth.json' }
        Distro = $Distro
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 4
    } else {
        $result
    }
    exit 0
}

$resolvedSourceWslPath = Convert-WindowsPathToWslPath -WindowsPath $resolvedSourcePath -TargetDistro $Distro
$effectiveTargetPath = if ($resolvedTargetPath) {
    $resolvedTargetPath
} else {
    (Get-WslHomeDirectory -TargetDistro $Distro).TrimEnd('/') + '/.codex/auth.json'
}
$targetDirectory = (($effectiveTargetPath -replace '\\', '/') -replace '/[^/]+$', '')
if (-not $targetDirectory) {
    throw "Unable to resolve the target directory for '$effectiveTargetPath'."
}

$null = & wsl.exe -d $Distro -- mkdir -p $targetDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create the target directory for '$effectiveTargetPath' in WSL distro '$Distro'."
}

$null = & wsl.exe -d $Distro -- test -f $effectiveTargetPath
$targetExistsExitCode = $LASTEXITCODE
if ($targetExistsExitCode -eq 0) {
    $null = & wsl.exe -d $Distro -- cmp -s $resolvedSourceWslPath $effectiveTargetPath
    $compareExitCode = $LASTEXITCODE
    if ($compareExitCode -eq 0) {
        $statusText = 'up-to-date'
    } elseif ($compareExitCode -eq 1) {
        $null = & wsl.exe -d $Distro -- cp $resolvedSourceWslPath $effectiveTargetPath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to copy Codex auth into WSL distro '$Distro'."
        }
        $null = & wsl.exe -d $Distro -- chmod 600 $effectiveTargetPath
        $statusText = 'copied'
    } else {
        throw "Failed to compare the existing Codex auth file in WSL distro '$Distro'."
    }
} elseif ($targetExistsExitCode -eq 1) {
    $null = & wsl.exe -d $Distro -- cp $resolvedSourceWslPath $effectiveTargetPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to copy Codex auth into WSL distro '$Distro'."
    }
    $null = & wsl.exe -d $Distro -- chmod 600 $effectiveTargetPath
    $statusText = 'copied'
} else {
    throw "Failed to inspect the target Codex auth path inside WSL distro '$Distro'."
}

$result = [pscustomobject]@{
    Synced = ($statusText -eq 'copied')
    Reason = if ($statusText) { $statusText } else { 'unknown' }
    SourcePath = $resolvedSourcePath
    TargetPath = $effectiveTargetPath
    Distro = $Distro
}

if ($Json) {
    $result | ConvertTo-Json -Depth 4
} else {
    $result
}
