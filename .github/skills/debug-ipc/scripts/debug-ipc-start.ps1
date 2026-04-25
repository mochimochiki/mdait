<#
.SYNOPSIS
  debug-ipc セッションを起動し、Extension Host の ready を待つ。
.DESCRIPTION
  VS Code バイナリを直接起動（既存インスタンスの干渉を回避）し、
  DebugCommandHandler の ready シグナルをポーリングする。
.PARAMETER Timeout
  ready 待ちのタイムアウト秒数（デフォルト: 90）
#>
param(
  [int]$Timeout = 90
)

$ErrorActionPreference = "Stop"

$workspace = "src/test/unit/workspace"
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

# バンドル（Extension Host は dist/extension.js を使うため必須）
Write-Host "[debug-ipc] Bundling..."
npm run bundle:dev --silent 2>$null

# VS Code バイナリパスを解決
# @vscode/test-electron のキャッシュを探す → バージョン番号でソートして選択 → なければシステムインストール
# 重要: システムインストールと同バージョンを避ける。
#   同バージョンだと mutex 競合で既存インスタンスにリクエストが転送され、
#   MDAIT_DEBUG_IPC 環境変数が伝わらず Extension Host が ready にならない。
$vscodeTestDir = ".vscode-test"
$codeBinary = $null
if (Test-Path $vscodeTestDir) {
  $candidates = Get-ChildItem -Path $vscodeTestDir -Recurse -Filter "Code.exe" -ErrorAction SilentlyContinue

  # システムインストールの VS Code バージョンを検出
  $systemVscode = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
  $systemVersion = $null
  if (Test-Path $systemVscode) {
    try {
      $vi = (Get-Item $systemVscode).VersionInfo
      $systemVersion = "$($vi.FileMajorPart).$($vi.FileMinorPart).$($vi.FileBuildPart)"
      Write-Host "[debug-ipc] System VS Code version: $systemVersion (will be avoided to prevent mutex conflict)"
    } catch {}
  }

  # バージョン番号でソートして最新を選択、ただしシステムVS Codeと同バージョンは避ける
  $sorted = $candidates | Sort-Object {
    if ($_.FullName -match 'archive-(\d+)\.(\d+)\.(\d+)') {
      [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]
    } else { 0 }
  } -Descending

  if ($systemVersion) {
    $codeBinary = $sorted | Where-Object {
      $_.FullName -match 'archive-(\d+\.\d+\.\d+)' -and $Matches[1] -ne $systemVersion
    } | Select-Object -First 1 -ExpandProperty FullName
  }
  # 同バージョンを除いた候補がなければ最新をそのまま使用
  if (-not $codeBinary) {
    $codeBinary = $sorted | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $codeBinary) {
  $codeBinary = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
}
if (-not (Test-Path $codeBinary)) {
  Write-Error "[debug-ipc] VS Code binary not found. Run 'npm run test:vscode' once to download, or install VS Code."
  exit 1
}

# バージョン確認
if ($codeBinary -match 'archive-(\d+\.\d+\.\d+)') {
  Write-Host "[debug-ipc] VS Code version: $($Matches[1])"
}

# 既存の Extension Development Host プロセスを終了
$staleProcs = Get-Process | Where-Object { $_.Path -like "*\.vscode-test\*" } -ErrorAction SilentlyContinue
if ($staleProcs) {
  Write-Host "[debug-ipc] Stopping $($staleProcs.Count) stale Extension Host process(es)..."
  $staleProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
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
# NOTE: --user-data-dir は指定しない。
# 指定すると AI 同意が未設定のプロファイルになり Extension Host が ready にならない。
# 同バージョンの VS Code が起動中の場合は mutex 競合が発生するが
# 既存プロセスの新ウィンドウで Extension Host が起動されるため通常は動作する。
# 起動しない場合は F5 (launch.json Run Extension) で起動すること。
$env:MDAIT_DEBUG_IPC = "1"

# ファイルベースIPCトリガーを作成
# 環境変数はmutex転送時に失われるためファイルで補完する
$ipcTrigger = "$workspace/.mdait/debug/.ipc-enabled"
New-Item -ItemType File -Path $ipcTrigger -Force | Out-Null

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

# ヘルスチェック: mdait.sync を発行して拡張機能が正常動作することを確認
Write-Host "[debug-ipc] Running health check (mdait.sync)..."
$commandFile = "$workspace/.mdait/debug/command.json"
$resultFile  = "$workspace/.mdait/debug/result.json"

Remove-Item $resultFile -ErrorAction SilentlyContinue
'{"id":"health-check","command":"mdait.sync","args":[]}' | Set-Content $commandFile -Encoding UTF8

$healthTimeout = (Get-Date).AddSeconds(30)
while (-not (Test-Path $resultFile) -or ((Get-Content $resultFile -Raw | ConvertFrom-Json).status -eq 'running')) {
  if ((Get-Date) -gt $healthTimeout) {
    Write-Warning "[debug-ipc] Health check timed out. Extension may not be functioning correctly."
    Write-Warning "[debug-ipc] Check that VS Code $($Matches[1]) is compatible with the installed Copilot Chat extension."
    break
  }
  Start-Sleep -Milliseconds 500
}

if (Test-Path $resultFile) {
  $health = Get-Content $resultFile -Raw | ConvertFrom-Json
  if ($health.status -eq 'done' -and $health.result.errorCount -eq 0) {
    Write-Host "[debug-ipc] Health check passed (sync: $($health.result.successCount) files OK)"
  } elseif ($health.status -eq 'done') {
    Write-Warning "[debug-ipc] Health check: sync completed with errors (errorCount=$($health.result.errorCount))"
  } else {
    Write-Warning "[debug-ipc] Health check failed: status=$($health.status), error=$($health.error)"
  }
}

Write-Host "[debug-ipc] IPC commands can now be sent to: $workspace/.mdait/debug/command.json"
