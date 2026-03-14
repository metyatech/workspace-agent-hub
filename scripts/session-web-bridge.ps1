param(
    [ValidateSet('list', 'start', 'rename', 'archive', 'unarchive', 'close', 'delete', 'output', 'send', 'interrupt')]
    [string]$Action,
    [ValidateSet('codex', 'claude', 'gemini', 'shell')]
    [string]$Type,
    [string]$SessionName = '',
    [string]$Title = '',
    [string]$WorkingDirectory = '',
    [string]$Text = '',
    [int]$Lines = 400,
    [string]$Distro = 'Ubuntu',
    [switch]$Submit,
    [switch]$IncludeArchived,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherScriptPath = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$wslBridgeScriptPath = Join-Path $PSScriptRoot 'wsl-session-bridge.sh'
$wslTmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'

if (-not (Test-Path -Path $launcherScriptPath)) {
    throw "Missing script: $launcherScriptPath"
}

if (-not (Test-Path -Path $wslBridgeScriptPath)) {
    throw "Missing script: $wslBridgeScriptPath"
}

if (-not (Test-Path -Path $wslTmuxScriptPath)) {
    throw "Missing script: $wslTmuxScriptPath"
}

function Invoke-LauncherCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File $launcherScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Launcher failed. Args: $($Arguments -join ' ')"
    }

    return @($raw)
}

function Invoke-LauncherJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $raw = Invoke-LauncherCommand -Arguments $Arguments
    $text = ($raw | Out-String).Trim()
    if (-not $text) {
        return $null
    }

    return ($text | ConvertFrom-Json)
}

function Get-AllSessions {
    $args = @('-Mode', 'list', '-Json')
    if ($IncludeArchived) {
        $args += '-IncludeArchived'
    } else {
        $args += '-IncludeArchived'
    }
    return @(Invoke-LauncherJson -Arguments $args)
}

function Get-SessionByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    foreach ($session in @(Get-AllSessions)) {
        if ([string]$session.Name -eq $TargetSessionName) {
            return $session
        }
    }

    return $null
}

function Wait-ForSessionByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [int]$TimeoutMilliseconds = 12000,
        [scriptblock]$Condition
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $lastSeen = $null
    do {
        $lastSeen = Get-SessionByName -TargetSessionName $TargetSessionName
        if ($lastSeen -and ((-not $Condition) -or (& $Condition $lastSeen))) {
            return $lastSeen
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    return $lastSeen
}

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    $normalizedPath = $WindowsPath -replace '\\', '/'
    $output = & wsl.exe -d $Distro -- wslpath -a -u $normalizedPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to convert Windows path to WSL path: $WindowsPath"
    }

    return (($output | Out-String).Trim())
}

function Invoke-WslBridge {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$BridgeArguments
    )

    $bridgeWslPath = Convert-WindowsPathToWslPath -WindowsPath $wslBridgeScriptPath
    $quotedArguments = foreach ($argument in $BridgeArguments) {
        "'$argument'"
    }
    $commandText = "$bridgeWslPath $($quotedArguments -join ' ')"
    $output = & wsl.exe -d $Distro -- bash -lc $commandText
    if ($LASTEXITCODE -ne 0) {
        throw "WSL bridge failed. Args: $($BridgeArguments -join ' ')"
    }
    return @($output)
}

if ($Action -eq 'list') {
    $sessions = @(Get-AllSessions)
    if ($Json) {
        if ($sessions.Count -eq 0) {
            '[]'
        } else {
            $sessions | ConvertTo-Json -Depth 6
        }
    } else {
        $sessions
    }
    exit 0
}

if ($Action -eq 'start') {
    if (-not $Type) {
        throw 'Use -Type with -Action start.'
    }
    if (-not $SessionName) {
        throw 'Use -SessionName with -Action start.'
    }

    [void](Invoke-LauncherCommand -Arguments @('-Mode', 'start', '-Type', $Type, '-Name', $SessionName, '-Title', $Title, '-WorkingDirectory', $WorkingDirectory, '-Distro', $Distro, '-Detach'))

    $resolvedName = "$Type-$SessionName"

    if ($Type -eq 'shell') {
        $resolvedWindowsWorkingDirectory = if ($WorkingDirectory -and $WorkingDirectory.Trim()) { $WorkingDirectory } else { Split-Path -Parent (Resolve-Path (Join-Path $PSScriptRoot '..')) }
        $resolvedWslWorkingDirectory = Convert-WindowsPathToWslPath -WindowsPath $resolvedWindowsWorkingDirectory
        [void](& powershell -NoProfile -ExecutionPolicy Bypass -File $wslTmuxScriptPath -Action ensure -SessionName $resolvedName -Distro $Distro -WorkingDirectory $resolvedWslWorkingDirectory -StartupCommand 'exec bash' -Detach)
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to stabilize detached shell session for web UI.'
        }
    }
    $session = Wait-ForSessionByName -TargetSessionName $resolvedName -Condition { param($candidate) [bool]$candidate.IsLive }
    if (-not $session) {
        throw "Started session '$resolvedName' but could not find it in the session catalog."
    }
    if (-not [bool]$session.IsLive) {
        throw "Started session '$resolvedName' but it did not become live within the expected time window."
    }

    if ($Json) {
        $session | ConvertTo-Json -Depth 6
    } else {
        $session
    }
    exit 0
}

if ($Action -in @('rename', 'archive', 'unarchive', 'close', 'delete')) {
    if (-not $SessionName) {
        throw 'Use -SessionName with this action.'
    }

    $args = @('-Mode', $Action, '-SessionName', $SessionName, '-Distro', $Distro)
    if ($Action -eq 'rename') {
        if (-not $Title -or -not $Title.Trim()) {
            throw 'Use -Title with -Action rename.'
        }
        $args += @('-Title', $Title)
    }

    [void](Invoke-LauncherCommand -Arguments $args)

    $session = switch ($Action) {
        'rename' {
            Wait-ForSessionByName -TargetSessionName $SessionName -Condition {
                param($candidate)
                ([string]$candidate.Title -eq $Title -or [string]$candidate.DisplayTitle -eq $Title)
            }
            break
        }
        'archive' {
            Wait-ForSessionByName -TargetSessionName $SessionName -Condition { param($candidate) [bool]$candidate.Archived }
            break
        }
        'unarchive' {
            Wait-ForSessionByName -TargetSessionName $SessionName -Condition { param($candidate) -not [bool]$candidate.Archived }
            break
        }
        'close' {
            Wait-ForSessionByName -TargetSessionName $SessionName -Condition { param($candidate) -not [bool]$candidate.IsLive }
            break
        }
        default {
            Get-SessionByName -TargetSessionName $SessionName
        }
    }
    if ($Action -eq 'delete') {
        $result = [pscustomobject]@{
            Deleted = $true
            SessionName = $SessionName
        }
    } elseif ($session) {
        $result = $session
    } else {
        $result = [pscustomobject]@{
            SessionName = $SessionName
            Action = $Action
        }
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 6
    } else {
        $result
    }
    exit 0
}

if ($Action -eq 'output') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Action output.'
    }

    $bridgeOutput = Invoke-WslBridge -BridgeArguments @('output', $SessionName, [string]$Lines)
    $pwdIndex = [Array]::IndexOf($bridgeOutput, '__WORKSPACE_AGENT_HUB_PWD__')
    $textIndex = [Array]::IndexOf($bridgeOutput, '__WORKSPACE_AGENT_HUB_TEXT_BEGIN__')
    if ($pwdIndex -lt 0 -or $textIndex -lt 0 -or $textIndex -lt $pwdIndex) {
        throw 'Unexpected output from WSL session bridge.'
    }

    $workingDirectoryWsl = if ($textIndex -ge ($pwdIndex + 1)) { [string]$bridgeOutput[$pwdIndex + 1] } else { '' }
    $textLines = @()
    if ($bridgeOutput.Count -gt ($textIndex + 1)) {
        $textLines = @($bridgeOutput[($textIndex + 1)..($bridgeOutput.Count - 1)])
    }

    $result = [pscustomobject]@{
        SessionName = $SessionName
        WorkingDirectoryWsl = $workingDirectoryWsl
        Transcript = (($textLines | Out-String).TrimEnd("`r", "`n"))
        CapturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 6
    } else {
        $result
    }
    exit 0
}

if ($Action -eq 'send') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Action send.'
    }

    $tempFile = Join-Path $env:TEMP ("workspace-agent-hub-send-" + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        Set-Content -Path $tempFile -Value $Text -NoNewline
        $wslPayloadPath = Convert-WindowsPathToWslPath -WindowsPath $tempFile
        $submitMode = if ($Submit) { 'submit' } else { 'paste-only' }
        [void](Invoke-WslBridge -BridgeArguments @('send', $SessionName, $wslPayloadPath, $submitMode))

        $result = [pscustomobject]@{
            SessionName = $SessionName
            Submitted = [bool]$Submit
        }

        if ($Json) {
            $result | ConvertTo-Json -Depth 6
        } else {
            $result
        }
        exit 0
    } finally {
        if (Test-Path -Path $tempFile) {
            [IO.File]::Delete($tempFile)
        }
    }
}

if ($Action -eq 'interrupt') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Action interrupt.'
    }

    [void](Invoke-WslBridge -BridgeArguments @('interrupt', $SessionName))
    $result = [pscustomobject]@{
        SessionName = $SessionName
        Interrupted = $true
    }
    if ($Json) {
        $result | ConvertTo-Json -Depth 6
    } else {
        $result
    }
    exit 0
}

throw "Unsupported action '$Action'."
