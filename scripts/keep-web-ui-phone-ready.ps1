param(
    [int]$Port = 3360,
    [string]$AuthToken = '',
    [string]$StatePath = '',
    [int]$IntervalSeconds = 60,
    [int]$MaxIterations = 0,
    [switch]$OpenBrowser,
    [string]$EnsureScriptPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DefaultStatePath {
    $stateDirectory = Join-Path $env:USERPROFILE 'agent-handoff'
    return (Join-Path $stateDirectory 'workspace-agent-hub-web-ui.json')
}

function Resolve-StatePath {
    if ($StatePath -and $StatePath.Trim()) {
        return [IO.Path]::GetFullPath($StatePath.Trim())
    }

    return (Get-DefaultStatePath)
}

function Ensure-DirectoryExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    $directory = Split-Path -Parent $TargetPath
    if ($directory -and -not (Test-Path -Path $directory)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
}

function Get-WatchdogLogPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    $directory = Split-Path -Parent $TargetStatePath
    if (-not $directory) {
        $directory = $PWD.Path
    }
    return (Join-Path $directory 'workspace-agent-hub-phone-ready.log')
}

function Write-WatchdogLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LogPath,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Ensure-DirectoryExists -TargetPath $LogPath
    $timestamp = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -Path $LogPath -Value ("[{0}] {1}" -f $timestamp, $Message) -Encoding utf8
}

function Get-MutexName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetStatePath
    )

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes($TargetStatePath.ToLowerInvariant())
        )
    } finally {
        $sha256.Dispose()
    }
    $hex = ([BitConverter]::ToString($hash)).Replace('-', '')
    return ('Local\WorkspaceAgentHubPhoneReady-' + $hex)
}

$resolvedEnsureScriptPath = if ($EnsureScriptPath -and $EnsureScriptPath.Trim()) {
    [IO.Path]::GetFullPath($EnsureScriptPath.Trim())
} else {
    Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
}
if (-not (Test-Path -Path $resolvedEnsureScriptPath)) {
    throw "Missing script: $resolvedEnsureScriptPath"
}

$resolvedStatePath = Resolve-StatePath
$watchdogLogPath = Get-WatchdogLogPath -TargetStatePath $resolvedStatePath
$mutexName = Get-MutexName -TargetStatePath $resolvedStatePath
$mutex = [Threading.Mutex]::new($false, $mutexName)
$lockAcquired = $false

try {
    try {
        $lockAcquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $lockAcquired = $true
    }
    if (-not $lockAcquired) {
        Write-Output 'Workspace Agent Hub phone-ready watchdog is already running.'
        exit 0
    }

    $iteration = 0
    while ($true) {
        try {
            $arguments = @{
                Port = $Port
                StatePath = $resolvedStatePath
                PhoneReady = $true
            }
            if ($AuthToken -and $AuthToken.Trim()) {
                $arguments['AuthToken'] = $AuthToken.Trim()
            }
            if ($OpenBrowser -and $iteration -eq 0) {
                $arguments['OpenBrowser'] = $true
            }

            & $resolvedEnsureScriptPath @arguments | Out-Null
        } catch {
            Write-WatchdogLog -LogPath $watchdogLogPath -Message $_.Exception.Message
        }

        $iteration += 1
        if ($MaxIterations -gt 0 -and $iteration -ge $MaxIterations) {
            break
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    if ($lockAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
