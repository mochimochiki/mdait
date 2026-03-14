# Story

(新しい情報が上)

## 2026/03/15: TM正規化でinline保持とfrontmatter除外を修正

**背景:** TM 用の Markdown 正規化テストが更新され、インラインコードを保持したい一方で、文書先頭の YAML frontmatter が正規化結果へ混入している問題が見えてきた。TM 登録と検索は同一の正規化契約を共有するため、局所修正だけでは downstream テストや設計記述との不整合が残る状態だった。

**要求:** stripMarkdown で inline code を保持し、先頭 frontmatter を除外する。既存のコードブロック除外や構造保持は崩さず、関連テストと TM 検索側の期待値まで揃える。

**意思決定:** frontmatter は parser 依存ではなく stripMarkdown 前処理で文書先頭だけを除外し、inline code は `code_inline` トークンをバッククォート付きで保持する方針にした。これにより既存の markdown-it ベース設計を保ったまま最小差分で仕様を満たせる。

**実装:** [src/core/tm/tm-text-normalizer.ts](../src/core/tm/tm-text-normalizer.ts) に先頭 frontmatter 除去パターンと inline code 保持を追加し、[src/test/core/tm/tm-text-normalizer.test.ts](../src/test/core/tm/tm-text-normalizer.test.ts) と [src/test/commands/trans/trans-tm-lookup.test.ts](../src/test/commands/trans/trans-tm-lookup.test.ts) を追従させた。レビューで downstream テスト漏れと削除線期待値の不整合が見つかり、修正後に承認された。設計書も [docs/design/core.md](../docs/design/core.md#L183) へ同期済み。

**詳細:** [tasks/done/260315_tm正規化_inline保持とfrontmatter除外.md](done/260315_tm正規化_inline保持とfrontmatter除外.md)

---

## 2026/03/08: tm-commitフォルダをtmフォルダに統合

**背景:** `src/commands/tm-commit/` と `src/commands/tm/` が並立しており、同じTM（翻訳メモリ）機能の一部なのに別フォルダに分散していた。コードナビゲーションの分かりにくさとtmフォルダ内の命名不統一（`command-open.ts` vs `tm-commit-command.ts`）が問題。

**要求:** `tm-commit-command.ts` を `command-commit.ts` にリネームしてtmフォルダに統合する。影響範囲を並列エージェントで調査し全修正を行う。

**意思決定:** コマンドIDも `mdait.tm-commit.*` → `mdait.tm.commit.*` へ変更し一貫性を確保。ロガーコンテキスト文字列も同様に統一。これは feature-tmブランチ開発中のため後方互換性リスクなし。

**実装:** ファイル4本の移動・リネーム、extension.ts・package.json・NLSファイルの更新、旧フォルダ削除、テストファイルも対応。レビュー指摘（不要export除去、ロガーコンテキスト統一）を修正し承認。

**詳細:** [tasks/done/260308_tm-commit-into-tm.md](done/260308_tm-commit-into-tm.md)
