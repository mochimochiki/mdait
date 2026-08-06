# AGENTS.md

## Map

- `docs/adr.md` : 主要な設計判断の記録。
- `docs/roadmaps/*.md`: 複数フェーズにまたがる中長期計画。段階の順序と依存はここを見る。
- `docs/design.md`: アーキテクチャの基準ドキュメント。機能設計やトレードオフ判断の前に参照。
- `docs/design/*.md`: モジュールごとの詳細ドキュメントはここにある。
- `docs/ux.md`: UX の基準ドキュメント。**UI に何かを出す・変える前に必ず §3.3「サーフェスの役割分担（デザイン言語）」を読む**（操作・状態・解説をどこに載せるかの取り決め）。

## Command

```bash
npm run compile        # TypeScriptコンパイル (tsc → out/)
npm run lint           # Biomeリント (設定: .config/biome.json)
npm test               # compile + lint + 単体テスト (mocha, TDD UI)
npm run test:vscode    # VS Code統合テスト（手動実行、CI対象外）
npm run watch          # 開発用esbuildウォッチ
npm run bundle         # 本番バンドル (esbuild → dist/extension.js)
npm run copy-test-files  # src/test/unit/sample-content からテストワークスペースをリセット
```

```bash
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/core/hash/**/*.test.js"
# またはテスト名でフィルタ（テスト名は日本語で書かれている）:
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/**/*.test.js" --grep "正規化"
```

CI（`.github/workflows/ci.yml`）の実行内容: `npm ci` → `compile` → `lint` → `test` → `bundle` → vsce package。

### 固定された不変条件（変更禁止）

- マーカー形式 `<!-- mdait hash from:xxx need:yyy -->` と CRC32 ハッシュアルゴリズム（既存マーカーとの互換性のため）
- パーサーは markdown-it。ユニット境界は見出しレベルベース
- ファイルパス構築は `Configuration` クラスに一元化 — コマンド層で `.mdait/` パスを直接構築しないこと
- 生の正規表現によるマーカー境界探索は `getCodeBlockLineSet` でコードブロック行を除外すること（コードブロック内のサンプルマーカーへの誤マッチを防ぐ）
- テキスト正規化（`normalizeForTm` など）はそれを必要とするモジュールの内部に閉じ込める。呼び出し側は生テキストを渡す
- 定常 sync（autoSyncOnSave 含む）は AI 不使用・決定的・冪等を維持する。AI を使う処理（trans・term・tm・ai-sync 系）は必ず明示的な起動＋確認UIを経由する（ADR-260705-01）
- 個別ユニットのマーカー／`unit-state` を書き換える操作は `getFileHandler()` の `resolveNeed` / `declareIsolate` / `deleteUnit` / `keepUnits` / `deleteAllVerifyDeletion` だけを通す。排他制御・未保存の反映・ストア保存・ステータス更新は `commands/markers/unit-mutation.ts` にしか無く、サーフェス（CodeLens・ツリー・LM Tool）側で書き換えを実装すると必ず取りこぼす。verify-deletion の Keep（独立化）は need と from を同時に外す必要があるため必ず `keepUnits` を使う — 別々に外すとレガシー形を再生産する（ADR-260805-01）。一括変換（markers-migration・sync・trans・ai-review のコア）は別枠（ADR-260726-01）。訳文ファイルごと手放す操作（孤立訳文の破棄）は `unit-mutation.ts` の `discardTargetFile` だけを通す — 削除は必ずごみ箱経由（`useTrash`）で、ファイルを消してから行を消す（逆順にすると削除失敗時に行だけ失われ、二度と気づけなくなる）
- 孤立訳文（原文と結びついていない訳文）の判定は `core/unit-state/orphan-target.ts` の `isOrphanTarget` だけを通す。**この事実はどこにも記録せず、必要になるたびディスクから計算する**（ADR-260806-01）。記録すると7列固定を破り、行の寿命という未決事項が生まれる
- `Status` は「原文側か訳文側か／翻訳の進み具合」だけを表す。「翻訳率の分母に数えるか」を `Status` の値で表現しない（`isCountedInProgress()` が単独で答える）。`contextValue` の決定に `Status` を渡さない（ADR-260726-01）
- 実行レポートを出すコマンドは、必ず `commands/shared/report-file.ts` 経由で `.mdait/reports/<kind>.md` へ書き出し、完了通知のボタンから開く。コマンドごとに独自の表示方法を実装しない（ADR-260726-01）
- 管理下 Markdown のマーカー読取（`markdownParser.parse` / `stringify`）は必ず `infra/config/marker-io.ts` の `resolveMarkerIO` / `resolveMarkerIOForFile` で解決した provider/ctx を渡す。素の `parse(content, config)` は external マーカーモードでマーカーを見失い静かに誤動作する。例外は markers-migration（両表現を意図的に parse する）と、パーサー・FrontMatter 内部のみ（ADR-260801-01）

## テスト

3層構成（`docs/design/test.md` 参照）:

1. **単体**（`npm test`、CI常時）: core + VS Code 非依存のコマンドロジック。VS Code 依存モジュールは `src/test/unit/__mocks__/register-vscode-mock.js` で登録されるモックを使用。テスト側で `global.__vscodeMockWorkspaceRoot` を設定可能。
2. **統合**（`npm run test:vscode`、手動）: `src/test/gui/**` を VS Code Test Runner で実行。
3. **探索的デバッグIPC**: `MDAIT_DEBUG_IPC=1` でファイルベース IPC を有効化し、マルチステップ E2E シナリオを実行 — `.claude/skills/debug-ipc/` の `debug-ipc` スキルを参照。

規約: TDDスタイル（`suite`/`test`）、**テスト名は日本語で期待される動作を明示する**。新しいエッジケースは `src/test/unit/sample-content/` に追加する（`copy-test-files` でテストワークスペースに同期される）。

## 規約

- 設計判断は `docs/adr.md` に ADR として記録する（短く、1画面以内、新しいものを上に）。
- l10n: ユーザー向け文字列は VS Code l10n を経由する（`l10n/bundle.l10n.json` + `.ja.json`、`package.nls.json` + `.ja.json`）。`npm run l10n` で再生成。
