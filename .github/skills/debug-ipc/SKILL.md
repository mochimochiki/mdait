---
name: debug-ipc
description: "Extension Hostのデバッグ起動中にファイルベースIPCでmdaitコマンドを発行・結果確認するためのSkillです。統合テスト、シナリオ検証、デバッグ実行時に使います。Use when: debugging mdait commands, running integration tests via IPC, verifying translation/sync/TM workflows end-to-end."
---

# Debug IPC — ファイルベースIPCによるデバッグ実行

## 前提条件

- Extension Host が **F5（launch.json の `Run Extension`）** で起動済みであること
- `MDAIT_DEBUG_IPC=1` 環境変数が設定されている（launch.json で自動設定）
- プロファイルは `mdait-debug`（AI同意ダイアログが記憶される）
- テストワークスペース: `src/test/workspace`

**注意**: CLI（`code` コマンド）からの Extension Host 起動では環境変数が伝播しない。必ず F5 を使うこと。

## IPC プロトコル

### ファイルパス

| ファイル | パス | 役割 |
|---------|------|------|
| command.json | `src/test/workspace/.mdait/debug/command.json` | コマンド発行（Agent → Extension Host） |
| result.json | `src/test/workspace/.mdait/debug/result.json` | 結果返却（Extension Host → Agent） |

### command.json スキーマ

```json
{
  "id": "<一意のID>",
  "command": "mdait.<コマンド名>",
  "args": []
}
```

- `id`: リクエスト識別子（任意文字列）
- `command`: `mdait.` プレフィックス必須
- `args`: コマンド引数の配列。文字列パスを渡せば Handler が自動変換する

### result.json スキーマ

```json
{
  "id": "<command.jsonのidと同一>",
  "command": "mdait.sync",
  "status": "done",
  "result": null,
  "error": null,
  "logs": ["[timestamp][LEVEL][scope] message | {context}"],
  "structuredLogs": [
    {
      "level": "info",
      "scope": "sync",
      "message": "Sync started",
      "context": { "pairCount": 1 },
      "timestamp": "2026-03-28 12:00:00"
    }
  ],
  "startedAt": "ISO8601",
  "completedAt": "ISO8601"
}
```

- `status`: `"running"` → 実行中, `"done"` → 成功, `"done-with-errors"` → 成功だがエラーあり（resultのerrorCount > 0）, `"error"` → 失敗
- `logs`: コマンド実行中にLoggerが出力した全ログ行（フォーマット済み文字列）
- `structuredLogs`: 構造化されたログエントリの配列。各エントリは `level`, `scope`, `message`, `context`（任意）, `timestamp` を持つ

## 実行手順

### 1. 前回の結果をクリア

```powershell
Remove-Item "src/test/workspace/.mdait/debug/result.json" -ErrorAction SilentlyContinue
```

### 2. command.json を書き込む

`create_file` ツールで `src/test/workspace/.mdait/debug/command.json` に書き込む。

### 3. 結果をポーリング

```powershell
$rp = "<workspace>/src/test/workspace/.mdait/debug/result.json"
while (-not (Test-Path $rp) -or ((Get-Content $rp -Raw | ConvertFrom-Json).status -eq 'running')) {
  Start-Sleep -Milliseconds 500
}
Get-Content $rp -Raw
```

**重要**: LLM呼び出しを含むコマンド（trans等）は数十秒〜数分かかる場合がある。タイムアウトは十分に長く設定すること。

### 4. 次のコマンド

`result.json` の `status` が `"done"` or `"error"` を確認してから、次の `command.json` を書き込む。

## コマンド一覧と引数

### 引数なし

| コマンド | 説明 |
|---------|------|
| `mdait.sync` | ステータス同期 |
| `mdait.setup.createConfig` | 設定作成 |

### URI変換（第1引数: 絶対ファイルパス文字列 → vscode.Uri）

| コマンド | 説明 |
|---------|------|
| `mdait.trans` | 単体翻訳 |
| `mdait.translate.frontmatter` | Frontmatter翻訳 |

例: `"args": ["C:\\path\\to\\file.md"]`

### File StatusItem変換（第1引数: 絶対パス → `{type:"file", filePath, fileName}`）

| コマンド | 説明 |
|---------|------|
| `mdait.translate.file` | ファイル翻訳 |
| `mdait.tm.commit.file` | TMコミット（ファイル） |

例: `"args": ["C:\\path\\to\\file.md"]`

### Directory StatusItem変換（第1引数: 絶対パス → `{type:"directory", directoryPath, label}`）

| コマンド | 説明 |
|---------|------|
| `mdait.translate.directory` | フォルダ翻訳 |
| `mdait.tm.commit.directory` | TMコミット（フォルダ） |

例: `"args": ["C:\\path\\to\\directory"]`

## よくあるシナリオ

### sync → trans → TM登録（基本フロー）

```json
// Step 1: sync
{"id": "s1", "command": "mdait.sync", "args": []}

// Step 2: trans (need:translate のファイルを翻訳)
{"id": "s2", "command": "mdait.trans", "args": ["C:\\...\\content\\en\\file.md"]}

// Step 3: TM commit
{"id": "s3", "command": "mdait.tm.commit.file", "args": ["C:\\...\\content\\en\\file.md"]}
```

各ステップの間で `result.json` の `status` が `"done"` であることを確認すること。

### 改訂シナリオ（sync → trans → 原文変更 → re-sync → re-trans）

```
1. sync → trans → tm.commit の基本フローを実行
2. ソースファイル（ja側）のテキストを変更
3. re-sync: {"id":"r1","command":"mdait.sync","args":[]}
   → ソース側マーカーのハッシュ更新、ターゲット側に need:revise@{oldHash} が付く
4. re-trans: {"id":"r2","command":"mdait.trans","args":["C:\\...\\en\\file.md"]}
   → patchMode=true ならdiff翻訳、false なら全文再翻訳
```

**注意**: syncの `totalModified` カウントはターゲットの**コンテンツ変更**を数える。
ソース変更 → ターゲットマーカー更新（need:revise付与）は modified にカウントされないが正常動作。

### テストコンテンツのリセット

シナリオを最初からやり直す場合：
```powershell
npm run copy-test-files
```
これは `src/test/sample-content` → `src/test/workspace/content` にコピーする。
リセット後は Extension Host を**再起動しなくても**、sync から始められる。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| debugディレクトリが作られない | Extension Host未起動 or 環境変数未設定 | F5で起動し直す |
| status が running のまま | AI同意ダイアログ待ち | Extension Hostウィンドウで許可を押す |
| status が running のまま（長時間） | LLM呼び出しタイムアウト | ログを確認、モデル設定を確認 |
| command not allowed | mdait. プレフィックスがない | コマンド名を確認 |
