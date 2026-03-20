# Story

(新しい情報が上)

## 2026/03/16: sentenceSplitter TM登録除去（責務分離）

**背景:** `SentenceSplitter` はコメントに「trans実行時のTM検索で使用する」と明記されていたが、TM登録処理（tm-commit）の `TmxStore.getExistingTmSet()`・`TmCommitProcessor.deriveRequiredUpdateTuids()` でも使われていた。これはCore層に検索用ロジックが混入した責務違反であり、TM登録の保守性・層の純粋性を損なっていた。

**意思決定:** 3つの設計案（unitHash優先 / テキスト直接照合 / 責務分離）を架 architect に並列設計させ、设计レビューで案C（責務分離）を選択。`TmxStore` を「unitPathに属する全エントリを返す純粋データアクセス（`getEntriesByUnitPath`）」に縮小し、フィルタリングロジック（バケット化・hash優先・includes照合）を `filterRelevantEntries` としてCommands層に移譲した。sentenceSplitterは完全削除。

**実装:** `tmx-store.ts` に `getEntriesByUnitPath` を追加・`SentenceSplitter` 依存を除去、`commit-processor.ts` に `filterRelevantEntries` を新設・呼び出し経路を変更、テストを `processUnit` 統合テスト形式に更新。テスト20件全通過。

**詳細:** [tasks/done/260316_sentenceSplitter_TM登録除去.md](done/260316_sentenceSplitter_TM登録除去.md)

## 2026/03/15: TMX補助propを廃止し保存契約を簡素化

**背景:** `.mdait/translations.tmx` には primary sentence や unit 再処理用ハッシュを補助 prop として埋め込んでいたが、TM の正準キーはすでに `tuid` と各言語 `tuv` に寄っており、保存形式が冗長になっていた。特に `x-primary` と `x-source-hash` はサンプル TMX にも露出しており、互換と現在契約の境界が曖昧だった。

**要求:** `x-primary` と `x-source-hash` を新規保存から完全に除去しつつ、旧 TMX は読める状態を維持する。あわせて sourceHash 事前スキップを廃止し、tm-commit を guarded upsert のみで成立させる。

**意思決定:** 保存契約は `tuid + tuv + tuv provenance` を正本とし、補助 prop は出力しない方針に統一した。primary は `x-primary` がない旧 TMX でも `tuid` と一致する variant から復元し、旧ファイルの読込互換は維持する一方で、新規保存は常に簡素な形へ正規化することにした。

**実装:** [src/core/tm/tmx-store.ts](../src/core/tm/tmx-store.ts)、[src/commands/tm/command-commit.ts](../src/commands/tm/command-commit.ts)、[src/commands/tm/commit-processor.ts](../src/commands/tm/commit-processor.ts) を中心に補助 prop と sourceHash スキップ経路を除去し、[src/test/core/tm/tmx-store.test.ts](../src/test/core/tm/tmx-store.test.ts) などで旧 TMX 読込互換と補助 prop 非出力を固定した。関連テスト 30 件成功、`npx tsc --noEmit` 成功、レビュー承認まで確認した。

**詳細:** [tasks/done/260315_TMX補助prop廃止.md](done/260315_TMX補助prop廃止.md)

## 2026/03/15: TM登録primary基準化差分の総合レビュー修正を収束

**背景:** primaryLang 基準の tm-commit 再設計差分は大筋で成立していたが、総合レビューで「tm.retryLimit の設定導線不足」「sourceHash skip の順序退行」「existing TM set / required update の誤判定」「LLM 応答の fail-closed 不足」「旧互換ノイズ」が残っていることが見つかった。実装の中心線は保ったまま、局所修正で収束できるかが焦点だった。

**要求:** 3 観点レビューを並列に立て、TM.md 整合・コード品質・堅牢性の各観点で文句なしになるまで修正と再レビューを繰り返す。大きな設計変更は避け、今回の差分内で閉じる修正だけを行う。

**意思決定:** tm-commit retry は `tm.retryLimit` へ分離し、sourceHash 済みユニットは lineage 解決前に即 skip する。existing TM set は primary provenance を優先して same-file 重複文の混入を抑え、required update は current local 文面一致なら no-op 扱いにした。加えて LLM 応答は要素欠落や余計なプロパティを含めて fail-closed とし、duplicate new 応答の件数ぶれも吸収した。

**実装:** [src/config/configuration.ts](../src/config/configuration.ts)、[src/commands/tm/command-commit.ts](../src/commands/tm/command-commit.ts)、[src/commands/tm/commit-processor.ts](../src/commands/tm/commit-processor.ts)、[src/commands/tm/tm-entry-generator.ts](../src/commands/tm/tm-entry-generator.ts)、[src/core/tm/tmx-store.ts](../src/core/tm/tmx-store.ts) と関連テスト・ドキュメントを更新した。TM 関連と trans 側回帰を合わせて 38 件、追加の commit-processor 単体 6 件が成功し、3 観点レビューは最終的に全件承認となった。

**詳細:** [tasks/done/260315_TM登録primary総合レビュー修正.md](done/260315_TM登録primary総合レビュー修正.md)

## 2026/03/15: TM登録をprimaryLang基準の guarded upsert へ再設計

**背景:** TM登録は従来 source/target 相対の発想が残っており、`TM.md` で整理した「primary sentence を正準キーにして既存 TU 更新と新規 TU 追加を分離する」設計とずれていた。特に non-primary からの登録、既存 TU 更新の必須保証、cleanup 後の anchor 再利用が弱く、TM の正準性が崩れやすかった。

**要求:** tm-commit を primaryLang 基準へ切り替え、`tuid = hash(norm(primary sentence))` に統一する。primaryUnit 解決、existing TM set、required update、guard、focused retry、warning 付き継続までを一連で成立させ、設計書・プロンプト・テストも同期する。

**意思決定:** command 層で primaryUnit/localUnit を先に確定し、processor は guarded upsert に専念する構造へ分離した。existing TM set は file の部分一致ではなく sentence 単位と provenance を併用して抽出し、旧TMX互換は x-primary 不在時に tuid から primary を復元する保守的方針に寄せた。

**実装:** [src/commands/tm/command-commit.ts](../src/commands/tm/command-commit.ts)、[src/commands/tm/commit-processor.ts](../src/commands/tm/commit-processor.ts)、[src/commands/tm/tm-entry-generator.ts](../src/commands/tm/tm-entry-generator.ts)、[src/core/tm/tmx-store.ts](../src/core/tm/tmx-store.ts)、[src/prompts/defaults.ts](../src/prompts/defaults.ts) を中心に更新し、関連テストを拡張した。レビューで same-file 混入、旧TMX primary 推定、lineage 循環保護が指摘されたが、回帰テスト追加まで含めて収束し、TM 関連 31 件成功と `npx tsc --noEmit` 成功を確認した。

**詳細:** [tasks/done/260315_TM登録primary基準化.md](done/260315_TM登録primary基準化.md)

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
