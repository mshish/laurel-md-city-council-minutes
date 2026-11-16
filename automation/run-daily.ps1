[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CodexPath = 'C:\Users\mscis\.bun\install\global\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe',
    [ValidateRange(1, 180)]
    [int]$TimeoutMinutes = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$resolvedCodex = (Resolve-Path -LiteralPath $CodexPath -ErrorAction Stop).Path
$promptPath = Join-Path $PSScriptRoot 'prompt.md'
if (-not (Test-Path -LiteralPath $promptPath -PathType Leaf)) {
    throw "Codex prompt not found at $promptPath"
}

$runId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfffZ')
$runsRoot = Join-Path $resolvedRoot '.local\runs'
$runDirectory = Join-Path $runsRoot $runId
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

$eventsPath = Join-Path $runDirectory 'codex.jsonl'
$stderrPath = Join-Path $runDirectory 'codex.stderr.log'
$resultPath = Join-Path $runDirectory 'result.txt'
$promptText = [System.IO.File]::ReadAllText($promptPath, [System.Text.Encoding]::UTF8)
$promptText = $promptText.Replace('{{RUN_ID}}', $runId).Replace('{{RUN_DIR}}', $runDirectory)
$promptText = $promptText.Replace('<run-id>', $runId).Replace('<run-dir>', $runDirectory)
if ($promptText.Contains('{{RUN_ID}}') -or $promptText.Contains('{{RUN_DIR}}') -or
    $promptText.Contains('<run-id>') -or $promptText.Contains('<run-dir>')) {
    throw 'The automation prompt contains an unresolved run placeholder.'
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $resolvedCodex
$startInfo.WorkingDirectory = $resolvedRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)

foreach ($argument in @(
    'exec',
    '--approve-for-me',
    '--cd', $resolvedRoot,
    '--json',
    '--output-last-message', $resultPath,
    '-'
)) {
    $startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
    if (-not $process.Start()) { throw 'Could not start the Codex CLI.' }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($promptText)
    $process.StandardInput.Close()

    $timeoutMilliseconds = $TimeoutMinutes * 60 * 1000
    if (-not $process.WaitForExit($timeoutMilliseconds)) {
        try { $process.Kill($true) } catch { }
        $process.WaitForExit()
        [System.IO.File]::WriteAllText($eventsPath, $stdoutTask.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($stderrPath, $stderrTask.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))
        throw "Codex timed out after $TimeoutMinutes minutes; see the private run log under .local\runs\$runId."
    }

    [System.IO.File]::WriteAllText($eventsPath, $stdoutTask.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($stderrPath, $stderrTask.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))

    if ($process.ExitCode -ne 0) {
        throw "Codex exited with code $($process.ExitCode); see the private run log under .local\runs\$runId."
    }

    Write-Output "run_id=$runId status=complete result=$resultPath"
} finally {
    $process.Dispose()
}
