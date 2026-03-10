# タスクストーリー

---

## 2026/03/08: tm-commitフォルダをtmフォルダに統合

**背景:** `src/commands/tm-commit/` と `src/commands/tm/` が並立しており、同じTM（翻訳メモリ）機能の一部なのに別フォルダに分散していた。コードナビゲーションの分かりにくさとtmフォルダ内の命名不統一（`command-open.ts` vs `tm-commit-command.ts`）が問題。

**要求:** `tm-commit-command.ts` を `command-commit.ts` にリネームしてtmフォルダに統合する。影響範囲を並列エージェントで調査し全修正を行う。

**意思決定:** コマンドIDも `mdait.tm-commit.*` → `mdait.tm.commit.*` へ変更し一貫性を確保。ロガーコンテキスト文字列も同様に統一。これは feature-tmブランチ開発中のため後方互換性リスクなし。

**実装:** ファイル4本の移動・リネーム、extension.ts・package.json・NLSファイルの更新、旧フォルダ削除、テストファイルも対応。レビュー指摘（不要export除去、ロガーコンテキスト統一）を修正し承認。

**詳細:** [tasks/done/260308_tm-commit-into-tm.md](done/260308_tm-commit-into-tm.md)
