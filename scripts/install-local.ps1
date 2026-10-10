param(
  [string]$PackageDirectory = (Join-Path $PSScriptRoot '..\release\win-unpacked')
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($PackageDirectory)
$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$destination = [System.IO.Path]::GetFullPath((Join-Path $programsRoot 'AgentViewer'))
$expected = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AgentViewer'))
if ($destination -ne $expected -or $source -eq $destination) { throw '安装目录校验失败。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'AgentViewer.exe') -PathType Leaf)) { throw '找不到已打包的 AgentViewer.exe。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'resources\engines\libreoffice\program\soffice.exe') -PathType Leaf)) { throw '打包目录缺少内置 LibreOffice。' }

$running = Get-CimInstance Win32_Process -Filter "name = 'AgentViewer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($destination + '\', [System.StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw '已安装的 AgentViewer 正在运行。请先关闭窗口再更新。' }

New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }

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
} | ConvertTo-Json -Compress
