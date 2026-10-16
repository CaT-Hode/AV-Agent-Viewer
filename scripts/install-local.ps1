param(
  [string]$PackageDirectory = (Join-Path $PSScriptRoot '..\release\win-unpacked')
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($PackageDirectory)
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$destination = [System.IO.Path]::GetFullPath((Join-Path $programsRoot 'AgentViewer'))
$expected = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AgentViewer'))
if ($destination -ne $expected -or $source -eq $destination -or $source.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '安装目录校验失败。' }
if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw '安装目录是链接，未执行替换。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'AgentViewer.exe') -PathType Leaf)) { throw '找不到已打包的 AgentViewer.exe。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'resources\engines\libreoffice\program\soffice.exe') -PathType Leaf)) { throw '打包目录缺少内置 LibreOffice。' }
$critical = @('AgentViewer.exe', 'resources\app\dist\main\index.cjs', 'resources\app\dist\main\office-kit-windows.dll', 'resources\app\dist\main\office-model-worker.cjs', 'resources\app\dist\main\markdown-export-preload.cjs', 'resources\app\dist\renderer\index.html', 'resources\engines\pandoc\pandoc.exe')
foreach ($file in $critical) { if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw ('打包目录缺少文件: ' + $file) } }

$running = Get-CimInstance Win32_Process -Filter "name = 'AgentViewer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw '已安装的 AgentViewer 正在运行。请先关闭窗口再更新。' }

New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
$staging = [System.IO.Path]::GetFullPath((Join-Path $programsRoot ('AgentViewer.staging-' + [guid]::NewGuid().ToString('N'))))
$backup = [System.IO.Path]::GetFullPath((Join-Path $programsRoot ('AgentViewer.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))))
if ([System.IO.Path]::GetDirectoryName($staging) -ne $programsRoot -or [System.IO.Path]::GetDirectoryName($backup) -ne $programsRoot) { throw '安装暂存目录校验失败。' }
New-Item -ItemType Directory -Path $staging | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force }
foreach ($file in $critical) {
  if ((Get-FileHash -LiteralPath (Join-Path $source $file) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $staging $file) -Algorithm SHA256).Hash) { throw ('暂存文件校验失败: ' + $file) }
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
if ((Get-FileHash -LiteralPath (Join-Path $source 'AgentViewer.exe') -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash) { throw '安装文件校验失败。' }

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
