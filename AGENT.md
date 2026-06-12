# AGENT.md

このファイルは、AIコーディングエージェントがこのリポジトリで作業する際のガイダンスを提供する。

## プロジェクト概要

mdait は、LLM を活用した継続的・構造認識型の Markdown 翻訳のための VS Code 拡張機能である。Markdown を見出しレベルで「ユニット」に分割し、HTML コメントマーカー（`<!-- mdait {hash} from:{hash} need:{flag} -->`）として埋め込んだ CRC32 ハッシュで変更を追跡し、変更されたユニットのみを再翻訳する。外部 DB は持たず、すべての状態は文書自身の中に存在する（git フレンドリー・冪等・`sync` でいつでも復帰可能）。

## コマンド

```bash
npm run compile        # TypeScriptコンパイル (tsc → out/)
npm run lint           # Biomeリント (設定: .config/biome.json)
npm test               # compile + lint + 単体テスト (mocha, TDD UI)
npm run test:vscode    # VS Code統合テスト（手動実行、CI対象外）
npm run watch          # 開発用esbuildウォッチ
npm run bundle         # 本番バンドル (esbuild → dist/extension.js)
npm run copy-test-files  # src/test/unit/sample-content からテストワークスペースをリセット
```

単一テストファイルの実行（テストは `out/` のコンパイル済み JS に対して実行される）:

```bash
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/core/hash/**/*.test.js"
# またはテスト名でフィルタ（テスト名は日本語で書かれている）:
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/**/*.test.js" --grep "正規化"
```

CI（`.github/workflows/ci.yml`）の実行内容: `npm ci` → `compile` → `lint` → `test` → `bundle` → vsce package。

## アーキテクチャ

**`docs/architecture.md` がアーキテクチャの基準ドキュメント**である — 機能設計やトレードオフ判断の前に必ず参照すること。モジュールごとの詳細ドキュメントは `docs/design/*.md` にある。ADR は `docs/adr.md` に記録する（新しいものを上に追加。`.github/skills/` の `adr-recording` スキルを使用）。

層構造（下位層は上位層に依存しない）:

- **`src/core/`** — 純粋な翻訳ロジック。**VS Code API に非依存**: Markdownパース（markdown-it）、ハッシュ/正規化、ステータス、unit-registry、diff、TM、file-state。完全に単体テスト可能。
- **`src/commands/`** — core の関数を組み合わせたワークフロー: `sync`・`trans`・`term`・`tm`・`setup`・`trans-selection`、および `file-handler/` Strategy（MD/非MD分岐の集約点）。進捗表示・エラーハンドリング・キャンセル対応も責務。
- **`src/infra/`** — config（`Configuration` シングルトン経由の `.mdait/mdait.json`）、llm（vscode-lm / OpenAI / Ollama プロバイダーを持つ `AIService` 抽象化）、logging、ワークスペースファイル探索、デバッグIPC、オンボーディング。
- **`src/ui/`** — StatusTreeProvider・CodeLens・Hover・Welcomeビュー。VS Code 標準 UI パターンに準拠する。
- **`src/lm-tools/`** — Copilot Chat 向け LanguageModelTool API ラッパー（`mdait_getStatus` / `mdait_sync` / `mdait_translate`）。
- **`src/prompts/`** — AIプロンプト定義。すべてのシステムプロンプトは外部ファイルで上書き可能。

コアのデータフロー: 原文変更 → `sync` がハッシュ差分を検出してユニットに `need:translate` / `need:revise@{oldhash}` を付与 → `trans` が翻訳（diff-aware revise は差分と前回訳文のみを LLM に送り、手修正を保持する）→ `sync` 再実行で `need` をクリア。すべてのコマンドは冪等である。

### 固定された不変条件（変更禁止）

- マーカー形式 `<!-- mdait hash from:xxx need:yyy -->` と CRC32 ハッシュアルゴリズム（既存マーカーとの互換性のため）
- パーサーは markdown-it。ユニット境界は見出しレベルベース
- ファイルパス構築は `Configuration` クラスに一元化 — コマンド層で `.mdait/` パスを直接構築しないこと
- 生の正規表現によるマーカー境界探索は `getCodeBlockLineSet` でコードブロック行を除外すること（コードブロック内のサンプルマーカーへの誤マッチを防ぐ）
- テキスト正規化（`normalizeForTm` など）はそれを必要とするモジュールの内部に閉じ込める。呼び出し側は生テキストを渡す

## テスト

3層構成（`docs/design/test.md` 参照）:

1. **単体**（`npm test`、CI常時）: core + VS Code 非依存のコマンドロジック。VS Code 依存モジュールは `src/test/unit/__mocks__/register-vscode-mock.js` で登録されるモックを使用。テスト側で `global.__vscodeMockWorkspaceRoot` を設定可能。
2. **統合**（`npm run test:vscode`、手動）: `src/test/gui/**` を VS Code Test Runner で実行。
3. **探索的デバッグIPC**: `MDAIT_DEBUG_IPC=1` でファイルベース IPC を有効化し、マルチステップ E2E シナリオを実行 — `.github/skills/debug-ipc/` の `debug-ipc` スキルを参照。

規約: TDDスタイル（`suite`/`test`）、**テスト名は日本語で期待される動作を明示する**。新しいエッジケースは `src/test/unit/sample-content/` に追加する（`copy-test-files` でテストワークスペースに同期される）。

## 規約

- **ドキュメント出力は日本語で行う**（設計ドキュメント、ADR、チケット、テスト名）。
- フォーマットは Biome: タブ、行幅120文字、ダブルクォート。
- 作業は `.tasks/do/<YYMMDD>-<NN>_<作業名>.md` のチケットで管理する（NN は `.tasks/do/` と `.tasks/done/` を通した同日内の2桁連番）。テンプレートは `.github/copilot-instructions.md` にある。完了時は `pwsh -File .github/scripts/done.ps1 -TicketName <YYMMDD-NN_作業名>` で移動する。
- 設計判断は `docs/adr.md` に ADR として記録する（短く、1画面以内、新しいものを上に）。
- l10n: ユーザー向け文字列は VS Code l10n を経由する（`l10n/bundle.l10n.json` + `.ja.json`、`package.nls.json` + `.ja.json`）。`npm run l10n` で再生成。
