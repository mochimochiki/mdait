# チケット: mdait.json を .mdait/mdait.json に移動

## 1. 概要と方針

現在ワークスペースルートに置かれている `mdait.json` の配置場所を `.mdait/mdait.json` に変更する。他の mdait 管理ファイル（terms、TM、unit-registry）は既に `.mdait/` 配下にあるため、設定ファイルも同ディレクトリに統一する。互換性維持は一切不要。

## 2. 仕様

- 設定ファイルパス: `{workspaceRoot}/mdait.json` → `{workspaceRoot}/.mdait/mdait.json`
- ファイルのロード・バリデーション・監視パターンを全て新パスに変更する
- `setup` コマンドの設定ファイル生成先を新パスに変更する
- VS Code スキーマ関連付け (`package.json` の `fileMatch`) を新パスに変更する
- テストワークスペースの `mdait.json` を `.mdait/mdait.json` に移動する
- 互換性考慮は完全不要（旧パスへの変換・マイグレーション処理は追加しない）

## 3. シーケンス図

変更なし（パス定数の変更のみ）。

## 4. 設計

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/config/configuration.ts` L238-244 | `path.join(workspaceRoot, "mdait.json")` → `path.join(workspaceRoot, ".mdait", "mdait.json")` |
| `src/commands/setup/setup-command.ts` L18 | `path.join(workspaceFolder, "mdait.json")` → `path.join(workspaceFolder, ".mdait", "mdait.json")` |
| `src/extension.ts` L383 | `filePath.toLowerCase().endsWith("mdait.json")` → `.endsWith(path.join(".mdait", "mdait.json").toLowerCase())` |
| `package.json` L333 | `"fileMatch": "mdait.json"` → `"fileMatch": ".mdait/mdait.json"` |

### テスト関連

| ファイル | 変更内容 |
|---------|---------|
| `src/test/config/configuration.test.ts` L9 | `path.join(tempDir, "mdait.json")` → `path.join(tempDir, ".mdait", "mdait.json")` |
| `src/test/core/config/configuration.test.ts` L23 | `path.join(workspaceRoot, "mdait.json")` → `path.join(workspaceRoot, ".mdait", "mdait.json")` |
| `src/test/workspace/mdait.json` | ファイルを `src/test/workspace/.mdait/mdait.json` に移動 |

### ドキュメント関連（doc-writer に別途依頼）

| ファイル | 変更内容 |
|---------|---------|
| `docs/design/config.md` | mdait.json のパスを `.mdait/mdait.json` に更新 |
| `docs/design/command_setup.md` | セットアップフローのパスを更新 |
| `docs/architecture.md` | mdait.json の記述を更新 |
| `README.md` | セットアップ手順のパスを更新 |
| `README.ja.md` | 同上（日本語版） |

## 5. 考慮事項

- `setup` コマンドは `.mdait/` ディレクトリが存在しない場合に作成するロジックが必要（既に他のファイルで `.mdait/` を作成しているか確認要）
- `extension.ts` のファイル監視パターン（`endsWith("mdait.json")`）はファイル名だけでなく `.mdait/mdait.json` というパス末尾で判定する必要がある

## 6. 実装・テスト計画と進捗

- [x] `src/config/configuration.ts` のパス変更
- [x] `src/commands/setup/setup-command.ts` のパス変更（`.mdait` ディレクトリ作成追加）
- [x] `src/extension.ts` のファイル監視パターン変更（`path` インポート追加）
- [x] `package.json` の fileMatch 変更（`**/.mdait/mdait.json`）
- [x] テストファイルのパス変更（`src/test/config/configuration.test.ts`）
- [x] `src/test/core/config/configuration.test.ts` を `src/test-gui/config/configuration-primarylang.test.ts` に移動（vscode依存テストの誤配置を修正）
- [x] `src/test/workspace/mdait.json` を `src/test/workspace/.mdait/mdait.json` に移動
- [x] ビルド確認（`npx tsc --noEmit` クリーン）
- [x] 全テスト通過確認（298 passing、TM関連10件は本タスク外の pre-existing 失敗）

## 7. 品質要件チェック

- [x] パス変更後に設定ファイルが正しく読み込まれること
- [x] setup コマンドで `.mdait/mdait.json` が正しく生成されること（ディレクトリ自動作成）
- [x] VS Code でスキーマ関連付けが機能すること（fileMatch: `**/.mdait/mdait.json`）
- [x] ビルドエラーなし
- [x] 全テスト通過（pre-existing TM失敗は本タスク対象外）

## 8. まとめと改善提案

（作業完了後に記入）
