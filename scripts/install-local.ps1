param(
  [string]$PackageDirectory = (Join-Path $PSScriptRoot '..\release\win-unpacked'),
  [string]$StagingDirectory
)

$ErrorActionPreference = 'Stop'
function Get-FileSha256([string]$LiteralPath) {
  $stream = $null
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::Open($LiteralPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
  } finally {
    if ($stream) { $stream.Dispose() }
    $sha256.Dispose()
  }
}
function Resolve-InstallStagingDirectory([string]$LiteralPath, [string]$ProgramsRoot, [string]$Destination, [string]$Source) {
  # .NET Framework IsPathRooted accepts drive-relative paths such as C:stage.
  if ([string]::IsNullOrWhiteSpace($LiteralPath) -or $LiteralPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') { throw '暂存目录必须使用绝对路径。' }
  $candidate = [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd([char[]]'\/')
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if (-not [System.IO.Path]::GetDirectoryName($candidate).Equals($ProgramsRoot, $comparison) -or [System.IO.Path]::GetFileName($candidate) -notmatch '^AgentViewer\.staging-[0-9a-f]{32}$') { throw '暂存目录必须是 Programs 下的 AgentViewer.staging-32位十六进制标识直系目录。' }
  if ($candidate.Equals($Destination, $comparison) -or $candidate.Equals($Source, $comparison) -or $candidate.StartsWith($Source.TrimEnd('\') + '\', $comparison) -or $Source.StartsWith($candidate + '\', $comparison)) { throw '暂存目录不能是安装目录或打包源目录。' }
  if (-not (Test-Path -LiteralPath $candidate -PathType Container) -or ((Get-Item -LiteralPath $candidate -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw '暂存目录不存在或是链接，未执行替换。' }
  return $candidate
}
function Get-InstallInventory([string]$Root) {
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $files = New-Object 'System.Collections.Generic.Dictionary[string,long]' ([System.StringComparer]::OrdinalIgnoreCase)
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($rootPath)
  while ($pending.Count) {
    $directory = $pending.Pop()
    if ([System.IO.File]::GetAttributes($directory) -band [System.IO.FileAttributes]::ReparsePoint) { throw ('安装清单目录是链接: ' + $directory) }
    foreach ($path in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [System.IO.File]::GetAttributes($path)
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ('安装清单包含链接: ' + $path) }
      if ($attributes -band [System.IO.FileAttributes]::Directory) { $pending.Push($path) }
      else { $files.Add($path.Substring($rootPath.Length + 1), (New-Object System.IO.FileInfo $path).Length) }
    }
  }
  return ,$files
}
$reuseStaging = $PSBoundParameters.ContainsKey('StagingDirectory')
$source = [System.IO.Path]::GetFullPath($PackageDirectory)
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
# Direct invocation must enforce the same release gate as the npm command.
# Verify the source package's own catalog and fingerprints before any copying.
Push-Location -LiteralPath $projectRoot
try {
  & $npmCommand run mcp:budget
  if ($LASTEXITCODE -ne 0) { throw 'MCP工具上下文预算校验失败，未执行本机替换。' }
  & $nodeCommand (Join-Path $PSScriptRoot 'check-mcp-host.mjs') '--package' $source
  if ($LASTEXITCODE -ne 0) { throw 'MCP桌面认证或待安装包校验失败，未执行本机替换。' }
} finally { Pop-Location }
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$destination = [System.IO.Path]::GetFullPath((Join-Path $programsRoot 'AgentViewer'))
$expected = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AgentViewer'))
if ($destination -ne $expected -or $source -eq $destination -or $source.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '安装目录校验失败。' }
if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw '安装目录是链接，未执行替换。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'AgentViewer.exe') -PathType Leaf)) { throw '找不到已打包的 AgentViewer.exe。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'resources\engines\libreoffice\program\soffice.exe') -PathType Leaf)) { throw '打包目录缺少内置 LibreOffice。' }
$critical = @('AgentViewer.exe', 'resources\app\dist\main\index.cjs', 'resources\app\dist\main\office-kit-windows.dll', 'resources\app\dist\main\office-model-worker.cjs', 'resources\app\dist\main\markdown-export-preload.cjs', 'resources\app\dist\renderer\index.html', 'resources\engines\pandoc\pandoc.exe', 'resources\engines\libreoffice\program\soffice.exe')
foreach ($file in $critical) { if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw ('打包目录缺少文件: ' + $file) } }

$running = Get-CimInstance Win32_Process -Filter "name = 'AgentViewer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw '已安装的 AgentViewer 正在运行。请先关闭窗口再更新。' }

if ($reuseStaging) { $staging = Resolve-InstallStagingDirectory $StagingDirectory $programsRoot $destination $source }
else {
  New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
  $staging = [System.IO.Path]::GetFullPath((Join-Path $programsRoot ('AgentViewer.staging-' + [guid]::NewGuid().ToString('N'))))
}
$backup = [System.IO.Path]::GetFullPath((Join-Path $programsRoot ('AgentViewer.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))))
if ([System.IO.Path]::GetDirectoryName($staging) -ne $programsRoot -or [System.IO.Path]::GetDirectoryName($backup) -ne $programsRoot) { throw '安装暂存目录校验失败。' }
if (-not $reuseStaging) {
  New-Item -ItemType Directory -Path $staging | Out-Null
  Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force }
} else {
  $sourceFiles = Get-InstallInventory $source
  $stagedFiles = Get-InstallInventory $staging
  if ($sourceFiles.Count -ne $stagedFiles.Count) { throw '暂存目录与源目录的完整文件清单不一致。' }
  foreach ($file in $sourceFiles.Keys) {
    if (-not $stagedFiles.ContainsKey($file) -or $sourceFiles[$file] -ne $stagedFiles[$file]) { throw ('暂存文件缺失或字节长度不符: ' + $file) }
  }
}
$staging = Resolve-InstallStagingDirectory $staging $programsRoot $destination $source
foreach ($file in $critical) {
  $stagedFile = Join-Path $staging $file
  if (-not (Test-Path -LiteralPath $stagedFile -PathType Leaf)) { throw ('暂存目录缺少文件: ' + $file) }
  if ((Get-FileSha256 (Join-Path $source $file)) -ne (Get-FileSha256 $stagedFile)) { throw ('暂存文件校验失败: ' + $file) }
}
# Recheck after the copy. Never rename a running installed application.
$running = Get-CimInstance Win32_Process -Filter "name = 'AgentViewer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw ('复制期间已安装应用被启动，请退出后重试。完整暂存目录: ' + $staging) }
$hadPrevious = Test-Path -LiteralPath $destination -PathType Container
if ($hadPrevious) { Move-Item -LiteralPath $destination -Destination $backup }
try { Move-Item -LiteralPath $staging -Destination $destination }
catch { if ($hadPrevious -and -not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $backup -Destination $destination }; throw }

$installedExe = Join-Path $destination 'AgentViewer.exe'
$installedOffice = Join-Path $destination 'resources\engines\libreoffice\program\soffice.exe'
if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf) -or -not (Test-Path -LiteralPath $installedOffice -PathType Leaf)) { throw '安装文件复制不完整。' }
if ((Get-FileSha256 (Join-Path $source 'AgentViewer.exe')) -ne (Get-FileSha256 $installedExe)) { throw '安装文件校验失败。' }

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
$shortcutPath = Join-Path $startMenu 'AgentViewer.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $installedExe
$shortcut.WorkingDirectory = $destination
$shortcut.Description = 'AgentViewer 文档与网页阅读器'
$customIcon = Join-Path $destination 'resources\app\assets\agentviewer.ico'
$shortcut.IconLocation = if (Test-Path -LiteralPath $customIcon -PathType Leaf) { $customIcon } else { $installedExe + ',0' }
$shortcut.Save()

[pscustomobject]@{
  executable = $installedExe
  shortcut = $shortcutPath
  bundledOffice = $installedOffice
  bundledPandoc = Join-Path $destination 'resources\engines\pandoc\pandoc.exe'
  previousInstallation = if ($hadPrevious) { $backup } else { $null }
} | ConvertTo-Json -Compress
