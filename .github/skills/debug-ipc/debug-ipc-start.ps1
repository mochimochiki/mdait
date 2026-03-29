<#
.SYNOPSIS
  debug-ipc セッションを起動し、Extension Host の ready を待つ。
.DESCRIPTION
  VS Code バイナリを直接起動（既存インスタンスの干渉を回避）し、
  DebugCommandHandler の ready シグナルをポーリングする。
.PARAMETER Timeout
  ready 待ちのタイムアウト秒数（デフォルト: 60）
#>
param(
  [int]$Timeout = 60
)

$ErrorActionPreference = "Stop"

$workspace = "src/test/workspace"
$readyFile = "$workspace/.mdait/debug/ready"

# クリーンアップ
Remove-Item "$workspace/.mdait/debug/ready" -ErrorAction SilentlyContinue
Remove-Item "$workspace/.mdait/debug/result.json" -ErrorAction SilentlyContinue
Remove-Item "$workspace/.mdait/debug/command.json" -ErrorAction SilentlyContinue

# テストコンテンツ同期
Write-Host "[debug-ipc] Copying test content..."
npm run copy-test-files --silent 2>$null

# コンパイル
Write-Host "[debug-ipc] Compiling..."
npm run compile --silent 2>$null

# VS Code バイナリパスを解決
# @vscode/test-electron のキャッシュを探す → なければシステムインストール
$vscodeTestDir = ".vscode-test"
$codeBinary = $null
if (Test-Path $vscodeTestDir) {
  $codeBinary = Get-ChildItem -Path $vscodeTestDir -Recurse -Filter "Code.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codeBinary) {
  $codeBinary = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
}
if (-not (Test-Path $codeBinary)) {
  Write-Error "[debug-ipc] VS Code binary not found. Run 'npm run test:vscode' once to download, or install VS Code."
  exit 1
}

# Extension Development Host を直接起動（code CLIを経由しない）
Write-Host "[debug-ipc] Launching Extension Development Host..."
Write-Host "[debug-ipc] Binary: $codeBinary"
$codeArgs = @(
  "--new-window",
  "--extensionDevelopmentPath=$PWD",
  "$PWD/$workspace",
  "--profile=mdait-debug"
)
$env:MDAIT_DEBUG_IPC = "1"
Start-Process -FilePath $codeBinary -ArgumentList $codeArgs

# ready シグナルをポーリング
Write-Host "[debug-ipc] Waiting for Extension Host ready..."
$elapsed = 0
while (-not (Test-Path $readyFile)) {
  Start-Sleep -Milliseconds 500
  $elapsed += 0.5
  if ($elapsed -ge $Timeout) {
    Write-Error "[debug-ipc] Timeout: Extension Host did not become ready within ${Timeout}s"
    exit 1
  }
}

$readyTime = Get-Content $readyFile -Raw
Write-Host "[debug-ipc] Extension Host ready at $readyTime"
Write-Host "[debug-ipc] IPC commands can now be sent to: $workspace/.mdait/debug/command.json"
