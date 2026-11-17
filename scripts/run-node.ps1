# 用 DSH 自带的 Electron（node 模式）运行本插件目录下的 ESM 脚本。
# 用法：pwsh -File scripts\run-node.ps1 scripts\selftest.mjs [--port 45999]
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScriptArgs = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = $env:DSH_NODE_EXECUTABLE
if ([string]::IsNullOrEmpty($exe)) {
  throw 'DSH_NODE_EXECUTABLE 未设置：请在 DSH 会话环境中运行本脚本，或手动指定 Electron 可执行文件。'
}
$scriptPath = if ([System.IO.Path]::IsPathRooted($Script)) { $Script } else { Join-Path $root $Script }
if (-not (Test-Path $scriptPath)) { throw "脚本不存在：$scriptPath" }

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start = [System.Diagnostics.ProcessStartInfo]::new($exe)
$start.ArgumentList.Add($scriptPath)
foreach ($argument in $ScriptArgs) { $start.ArgumentList.Add($argument) }
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
