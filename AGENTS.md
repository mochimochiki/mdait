# AGENTS.md

## Map

- `docs/adr.md` : 主要な設計判断の記録。
- `docs/roadmaps/*.md`: 複数フェーズにまたがる中長期計画。段階の順序と依存はここを見る。
- `docs/tasks/*.md`: **ローカル専用のタスクチケット。`.gitignore` 済みで、リポジトリには載せない**（コミットも push もしない）。追跡対象の文書からチケット番号を参照しないこと — 手元にしか無いものを指すと、他の環境では辿れない参照になる。残す価値のある決定は ADR へ、段階の計画は roadmap へ書く。
- `docs/design.md`: アーキテクチャの基準ドキュメント。機能設計やトレードオフ判断の前に参照。
- `docs/design/*.md`: モジュールごとの詳細ドキュメントはここにある。
- `docs/ux.md`: UX の基準ドキュメント。**UI に何かを出す・変える前に必ず §3.3「サーフェスの役割分担（デザイン言語）」を読む**（操作・状態・解説をどこに載せるかの取り決め）。

## Command

```bash
npm run compile        # TypeScriptコンパイル (tsc → out/)
npm run lint           # Biomeリント (設定: .config/biome.json)
npm test               # compile + lint + 単体テスト + BYOK shim の単体テスト (mocha, TDD UI)
npm run test:vscode    # VS Code統合テスト（手動実行、CI対象外）
npm run test:byok      # BYOK shim 自身の単体テスト（npm test から呼ばれる、CI常時）
npm run test:byok:e2e  # 録音の再生で trans を検証（CI常時。新規翻訳12往復＋改訂3往復）
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
- 生の正規表現によるマーカー境界探索は `getCodeBlockLineSet` でコードブロック行を除外すること（コードブロック内のサンプルマーカーへの誤マッチを防ぐ）。**開始位置の探索にも同じ判定を当てる** — 終端だけ外していた時期があり、マーカーの書き方を解説する原稿で訳文がコードブロックの中へ書き込まれ、コードフェンスが閉じなくなった
- テキスト正規化（`normalizeForTm` など）はそれを必要とするモジュールの内部に閉じ込める。呼び出し側は生テキストを渡す
- 定常 sync（autoSyncOnSave 含む）は AI 不使用・決定的・冪等を維持する。AI を使う処理（trans・term・tm・ai-sync 系）は必ず明示的な起動＋確認UIを経由する（ADR-260705-01）
- 個別ユニットのマーカー／`unit-state` を書き換える操作は `getFileHandler()` の `resolveNeed` / `declareIsolate` / `deleteUnit` / `keepUnits` / `deleteAllVerifyDeletion` だけを通す。排他制御・未保存の反映・ストア保存・ステータス更新は `commands/markers/unit-mutation.ts` にしか無く、サーフェス（CodeLens・ツリー・LM Tool）側で書き換えを実装すると必ず取りこぼす。verify-deletion の Keep（独立化）は need と from を同時に外す必要があるため必ず `keepUnits` を使う — 別々に外すとレガシー形を再生産する（ADR-260805-01）。一括変換（markers-migration・sync・trans・ai-review のコア）は別枠（ADR-260726-01）。訳文ファイルごと手放す操作（孤立訳文の破棄）は `unit-mutation.ts` の `discardTargetFile` だけを通す — 削除は必ずごみ箱経由（`useTrash`）で、ファイルを消してから行を消す（逆順にすると削除失敗時に行だけ失われ、二度と気づけなくなる）
- 孤立訳文（原文と結びついていない訳文）の判定は `core/unit-state/orphan-target.ts` の `isOrphanTarget` だけを通す。**この事実はどこにも記録せず、必要になるたびディスクから計算する**（ADR-260806-01）。記録すると行の寿命という未決事項が生まれる
- ファイルの移動（リネーム・フォルダ移動）への追随は `commands/markers/rename-follow.ts` の2つの入口だけを通す。訳文を連れて動かすのは `onWillRenameFiles` の `waitUntil` に返す `WorkspaceEdit` でなければならない（ユーザーの取り消し単位に相乗りする唯一の方法。自前で動かすと Ctrl+Z で戻らない）。行の付け替えは移動後に `relocateUnitEntries` を通す — ストア全体の排他（`unit-state-lock`）と保存がそこにしか無く、抜けると sync の `load()` に無言で捨てられる（ADR-260807-01）
- `unit-mutation.ts` の Markdown 書き換えの入口は2つあり、**本文を変えるかどうか**で選ぶ。章そのものを消す `deleteUnit` は `withMarkdownMutation`、マーカーしか変えない `resolveNeed` / `keepUnits` / `declareIsolate` は `withMarkerOnlyMutation` を通す。後者は external で**絶対にファイルを書かない** — 「出来上がりが同じなら書かない」という比較では足りず、パーサーを通した書き出しは改行を LF に揃え余分な空行を詰めるため、正規形でない原稿（CRLF・空行2つ・末尾改行なし）では比較が必ず「変わった」と答える（実測で CRLF の原稿が全行 LF に書き換わった）。`stringify` は書き込みを見送るときも必ず呼ぶ（external ではそこでマーカーがストアへ引き取られる）。入口を選び違えると、本文の変更が external で無言で消えるか、原稿が整形で書き換わる（ADR-260822-02）
- 管理下の原稿の書き出しは `infra/workspace/managed-write.ts` の `writeManagedDocument` / `writeManagedDocumentSync` だけを通す。**Markdown も、Markdown 以外の管理下ファイル（.txt / .csv / .json）も同じ**（ADR-260902-04）。原稿の改行コードと末尾改行を測って揃え直し、出来上がりが1バイトも違わなければ書かない処理はそこにしか無い。素の `writeFile` で書くと、Windows で書かれた原稿が全行 LF に書き換わる（実測。内容は同じなのにファイル全体が差分になる）。例外は2つ — `.mdait/` の中の管理ファイルは原稿ではない。**まだ無いファイルへ原文をそのまま複製する経路（`plain-file-handler.syncNew`）は通してはいけない** — ディスクに何も無いと書式が既定（LF）と測られ、CRLF の原文がその場で倒れる。増殖は `managed-write-only.test.ts` がソース走査で見張る（ADR-260902-01）
- `stringify` は frontmatter の閉じ `---` と本文のあいだの空行を、原稿にあった数だけ再現する（`Markdown.frontMatterGap`。parse で測り stringify で書き戻す）。決め打ちで詰めると、静的サイトの原稿は取り込んだだけで**訳文のほぼ全ファイルが差分になる**（実測 19/23）。ユニット間の連結（空行1つ）とは別の話なので混ぜない（ADR-260903-02）
- `Status` は「原文側か訳文側か／翻訳の進み具合」だけを表す。「翻訳率の分母に数えるか」を `Status` の値で表現しない（`isCountedInProgress()` が単独で答える）。`contextValue` の決定に `Status` を渡さない（ADR-260726-01）
- 実行レポートを出すコマンドは、必ず `commands/shared/report-file.ts` 経由で `.mdait/reports/<kind>.md` へ書き出し、完了通知のボタンから開く。コマンドごとに独自の表示方法を実装しない（ADR-260726-01）
- 管理下 Markdown のマーカー読取（`markdownParser.parse` / `stringify`）は必ず `infra/config/marker-io.ts` の `resolveMarkerIO` / `resolveMarkerIOForFile` で解決した provider/ctx を渡す。素の `parse(content, config)` は external マーカーモードでマーカーを見失い静かに誤動作する。例外は markers-migration（両表現を意図的に parse する）と、パーサー・FrontMatter 内部のみ（ADR-260801-01）

## テスト

3層構成（`docs/design/test.md` 参照）:

1. **単体**（`npm test`、CI常時）: core + VS Code 非依存のコマンドロジック。VS Code 依存モジュールは `src/test/unit/__mocks__/register-vscode-mock.js` で登録されるモックを使用。テスト側で `global.__vscodeMockWorkspaceRoot` を設定可能。
2. **統合**（`npm run test:vscode`、手動）: `src/test/gui/**` を VS Code Test Runner で実行。
3. **探索的検証**（mdait Lab、`scripts/lab/lab.mjs`）: 入口は1つ。**ホスト**（headless / ブラウザ版 VS Code / デスクトップ版 VS Code）と **AI の相手**（`echo` 決定的・`live` 自分で答える・`script` 意地悪な台本・`replay` 録音の再生・`agent` claude を翻訳役に起動）を選び、命令はどのホストでも同じファイル IPC で送る。テスト用ワークスペースはリポジトリの外（`/tmp/mdait-lab/ws`）に作られる。`npm run test:explore`（決定的スイープ）と `npm run test:byok:e2e`（録音の再生）はここへの入口 — 使い方は `.claude/skills/mdait-lab/` の `mdait-lab` スキルを参照。

AI の相手はどれも OpenAI 互換のローカル受け皿（`scripts/lab/ai/`）の裏側にいるので、**どのモードでもプロバイダ層（リトライ・タイムアウト・`ai-stats.log`）まで本物が走る**。`AIService` ごと差し替える偽物は廃止した（ADR-260823-02）。

規約: TDDスタイル（`suite`/`test`）、**テスト名は日本語で期待される動作を明示する**。新しいエッジケースは `src/test/unit/sample-content/` に追加する（`copy-test-files` でテストワークスペースに同期される）。

## 規約

- 設計判断は `docs/adr.md` に ADR として記録する（短く、1画面以内、新しいものを上に）。
- l10n: ユーザー向け文字列は VS Code l10n を経由する（`l10n/bundle.l10n.json` + `.ja.json`、`package.nls.json` + `.ja.json`）。`npm run l10n` で再生成。
