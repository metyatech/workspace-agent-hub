param(
    [ValidateSet('list', 'start', 'rename', 'archive', 'unarchive', 'close', 'delete', 'output', 'send', 'interrupt')]
    [string]$Action,
    [ValidateSet('codex', 'claude', 'gemini', 'shell')]
    [string]$Type,
    [string]$SessionName = '',
    [string]$Title = '',
    [string]$TitlePath = '',
    [string]$WorkingDirectory = '',
    [string]$Text = '',
    [string]$TextPath = '',
    [int]$Lines = 400,
    [string]$Distro = 'Ubuntu',
    [switch]$Submit,
    [switch]$IncludeArchived,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8Encoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8Encoding
[Console]::OutputEncoding = $utf8Encoding

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

function Read-Utf8PayloadValue {
    param(
        [string]$PathValue = ''
    )

    if (-not $PathValue -or -not $PathValue.Trim()) {
        return ''
    }

    if (-not (Test-Path -Path $PathValue)) {
        throw "Missing payload file: $PathValue"
    }

    return (Get-Content -Path $PathValue -Raw -Encoding utf8)
}

function ConvertTo-QuotedArgumentString {
    param(
        [string[]]$ArgumentList = @()
    )

    $quoted = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if (-not $value.Length) {
            '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $value
            continue
        }

        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }
    return ($quoted -join ' ')
}

function Invoke-HiddenConsoleCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$ErrorContext = 'Hidden console command failed.'
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in $ArgumentList) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutText = $process.StandardOutput.ReadToEnd()
    $stderrText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $stdoutLines = if ($stdoutText) { @($stdoutText -split "`r?`n") | Where-Object { $_ -ne '' } } else { @() }
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = $stdoutText
        StdErr = $stderrText
        StdOutLines = $stdoutLines
    }
}

function Invoke-LauncherCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $scriptParameters = @{}
    $index = 0
    while ($index -lt $Arguments.Count) {
        $token = [string]$Arguments[$index]
        if (-not $token.StartsWith('-')) {
            throw "Launcher argument token must start with '-'. Got '$token'."
        }

        $parameterName = $token.TrimStart('-')
        $nextIsValue =
            ($index + 1) -lt $Arguments.Count -and
            -not (([string]$Arguments[$index + 1]).StartsWith('-'))
        if ($nextIsValue) {
            $scriptParameters[$parameterName] = [string]$Arguments[$index + 1]
            $index += 2
            continue
        }

        $scriptParameters[$parameterName] = $true
        $index += 1
    }

    $captured = & $launcherScriptPath @scriptParameters 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $detail = (($captured | Out-String).Trim())
        if (-not $detail) {
            $detail = "Exit code $exitCode."
        }
        throw "Launcher failed. Args: $($Arguments -join ' ') $detail"
    }

    return @($captured | ForEach-Object { [string]$_ })
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
    $launcherArgs = @('-Mode', 'list', '-Json', '-IncludeArchived')
    return @(Invoke-LauncherJson -Arguments $launcherArgs)
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
    $result = Invoke-HiddenConsoleCommand -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--', 'wslpath', '-a', '-u', $normalizedPath) -ErrorContext 'Unable to convert Windows path to WSL path.'
    if ($result.ExitCode -ne 0) {
        $detail = if ($result.StdErr.Trim()) { $result.StdErr.Trim() } elseif ($result.StdOut.Trim()) { $result.StdOut.Trim() } else { "Exit code $($result.ExitCode)." }
        throw "Unable to convert Windows path to WSL path: $WindowsPath $detail"
    }

    return $result.StdOut.Trim()
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
    $result = Invoke-HiddenConsoleCommand -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--', 'bash', '-lc', $commandText) -ErrorContext 'WSL bridge failed.'
    if ($result.ExitCode -ne 0) {
        $detail = if ($result.StdErr.Trim()) { $result.StdErr.Trim() } elseif ($result.StdOut.Trim()) { $result.StdOut.Trim() } else { "Exit code $($result.ExitCode)." }
        throw "WSL bridge failed. Args: $($BridgeArguments -join ' ') $detail"
    }
    return @($result.StdOutLines)
}

if ($TitlePath -and $TitlePath.Trim()) {
    $Title = Read-Utf8PayloadValue -PathValue $TitlePath
}

if ($TextPath -and $TextPath.Trim()) {
    $Text = Read-Utf8PayloadValue -PathValue $TextPath
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
        $stabilizeOutput = & $wslTmuxScriptPath -Action ensure -SessionName $resolvedName -Distro $Distro -WorkingDirectory $resolvedWslWorkingDirectory -StartupCommand 'exec bash' -Detach 2>&1
        if ($LASTEXITCODE -ne 0) {
            $detail = (($stabilizeOutput | Out-String).Trim())
            if (-not $detail) {
                $detail = "Exit code $LASTEXITCODE."
            }
            throw "Failed to stabilize detached shell session for web UI. $detail"
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

    $launcherArgs = @('-Mode', $Action, '-SessionName', $SessionName, '-Distro', $Distro)
    if ($Action -eq 'rename') {
        if (-not $Title -or -not $Title.Trim()) {
            throw 'Use -Title with -Action rename.'
        }
        $launcherArgs += @('-Title', $Title)
    }

    [void](Invoke-LauncherCommand -Arguments $launcherArgs)

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
        Set-Content -Path $tempFile -Value $Text -NoNewline -Encoding utf8
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
