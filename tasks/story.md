# Story

(新しい情報が上)

## 2026/03/15: primaryLang旧互換を削除してトップ階層必須に統一

**背景:** 直前の移設では既存設定を壊さないため `terms.primaryLang` の runtime 互換読込を残したが、今回は互換性不要になった。互換層を残すと設定責務が曖昧なままで、設計書にも移行メモが残り続けるため、top-level `primaryLang` だけを正とする状態まで整理する必要があった。

**要求:** 旧 `terms.primaryLang` の互換読込と関連する説明・テスト痕跡を消し、`primaryLang` 未設定は明示的な設定不備として扱う。設定移設の本筋だけを残し、TM 機能本体には触れない。

**意思決定:** runtime は top-level `primaryLang` だけを読む実装へ戻し、schema と validation でも `primaryLang` を必須化した。これにより旧設定の自動救済は行わない代わりに、失敗を silent failure ではなく明示的な validation error に揃えた。

**実装:** [src/config/configuration.ts](../src/config/configuration.ts) から旧 `terms.primaryLang` の互換読込と非推奨警告を削除し、`validate()` に `primaryLang` 必須チェックを追加した。[schemas/mdait-config.schema.json](../schemas/mdait-config.schema.json) でも root required に `primaryLang` を追加し、[src/test/core/config/configuration.test.ts](../src/test/core/config/configuration.test.ts) は互換テストを削除して未設定エラー検証へ置き換えた。[docs/design/config.md](../docs/design/config.md) の移行メモも削除した。

**詳細:** [tasks/done/260315_primaryLang互換削除.md](done/260315_primaryLang互換削除.md)

## 2026/03/15: primaryLangをterms配下からトップ階層へ移設

**背景:** TM 機能を `sourceLang` 依存から `primaryLang` 基準へ寄せていく前提として、設定上でも `primaryLang` を用語集専用の `terms` 配下に置いたままにしない方がよかった。現状のままでは設定責務の説明がぶれ、TM と用語集の双方で参照する基準言語が構造上も語義上も不自然だった。

**要求:** `mdait.json` の `terms.primaryLang` をトップ階層 `primaryLang` へ移し、この変更だけを安全に完遂する。設定読み込み、JSON Schema、テンプレート、テスト用設定、設計書を同期し、TM 本体の仕様変更には踏み込まない。

**意思決定:** 正準キーはトップ階層 `primaryLang` としつつ、既存ユーザーを静かに壊さないため runtime では `terms.primaryLang` を移行期間の互換キーとして残した。優先順位は top-level を常に優先し、旧キーは schema とテンプレートから外して移行方向だけを明確にした。

**実装:** [src/config/configuration.ts](../src/config/configuration.ts) で top-level 読み込みへ切り替え、旧キーは互換読込 + 非推奨警告にした。[schemas/mdait-config.schema.json](../schemas/mdait-config.schema.json)、[mdait.template.json](../mdait.template.json)、[src/test/workspace/mdait.json](../src/test/workspace/mdait.json)、[docs/design/config.md](../docs/design/config.md) を同期し、[src/test/core/config/configuration.test.ts](../src/test/core/config/configuration.test.ts) で新キー読込・旧キー互換・優先順位を固定した。レビューで後方互換性不足が指摘されたが、互換層追加後に承認された。

**詳細:** [tasks/done/260315_primaryLangトップ階層移設.md](done/260315_primaryLangトップ階層移設.md)

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
