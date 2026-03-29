# Story

(新しい情報が上。各エントリは100-200文字の自然文で、何があってどう判断したかを簡潔に伝える)

## 2026/03/28: patchMode保護と可観測性改善

自律デバッグ検証でpatchMode失敗時にサイレント全文再翻訳→手修正消失という致命的バグを発見。applyUnifiedPatchに@@ハンク行補完を追加してLLMのパッチ形式揺れを吸収し、それでも失敗する場合はshowWarningMessageで確認ダイアログを出してスキップ可能にした。レビューでCodeLens経由のtransUnit_CoreProcにスキップ判定漏れが見つかり追加修正。translateFile/translateUnitの戻り値修正とTMログINFO昇格も併せて実施。→ [詳細](done/260328_patchMode保護と可観測性改善.md)

## 2026/03/28: debug-ipc可観測性改善（第2弾）

実際のバグ（空ファイルsync時のENOENT）をお題に自律デバッグの仕組みを評価した。sync部分失敗がstatus:doneで返る問題、ログが文字列のみで構造化されてない問題、スキップ理由の「なぜ」が不足する問題を発見。done-with-errorsステータス、structuredLogsフィールド、診断ログ強化の3件を即座に実装。Loggerの`LogListener`シグネチャを拡張しentry付きに変更。→ [詳細](done/260328_デバッグ可観測性改善.md)

## 2026/03/28: デバッグ可観測性改善

sync/transコマンドがvoidを返していたため、debug-ipcのresult.jsonで構造化アサーションができなかった。tm.commitに倣いSyncResult/TransCommandResult型を導入し戻り値を構造化。syncにはrevisionsNeeded（need:revise付与件数）を追加してtotalModifiedとの混同を解消。patchMode不発はコードトレースで構造的欠陥なしと判断し、診断ログを強化して再現待ちとした。自律テスト設計の基盤が整った。→ [詳細](done/260328_デバッグ可観測性改善.md)

## 2026/03/28: デバッグ環境ファイルベースIPC

エージェントが自律的にLLM込みの統合シナリオをテストできるよう、Extension Host内にファイルベースIPCを導入した。`.mdait/debug/`にコマンドJSONを書くとFileSystemWatcherが検知して実行し結果を返す仕組みで、環境変数ガードと動的importによりリリースビルドには一切影響しない。レビューで引数型変換の不整合が見つかり修正して承認。第2マイルストーンでLoggerにonLogリスナー機構を追加しresult.jsonにログキャプチャを実装、`--profile-temp`を`--profile=mdait-debug`に変更してAI同意ダイアログの永続化も対応。フルシナリオ（sync→trans→tm.commit→改訂→re-sync→re-trans）をIPC経由で実行し正常動作とログキャプチャを確認。洗い出しでterm系コマンドのarg変換不足、patchMode判定理由ログの欠如、TM参照ヒットログの欠如を発見し修正。debug-ipc Skillを作成。→ [詳細](done/260328_デバッグ環境ファイルベースIPC.md)

## 2026/03/22: TM検索クエリの文単位分割

TM登録は文単位なのに検索は段落単位で、粒度のギャップがJaccard類似度を薄めていた。SentenceSplitter経由ではなく、normalizeForTm→改行分割→Intl.Segmenter文分割のハイブリッドパイプラインを採用し、markdown-itの改行正規化でCRLF問題を構造的に回避した。→ [詳細](do/260322_TM検索クエリ文単位分割.md)

## 2026/03/22: 結果プレビューの視認性改善とTerm Detect結果プレビュー追加

tm-commitの結果が1行詰め込みで読みづらく、term-detectにはプレビュー自体がなかった。TM結果を原文・訳文の2行表示に改善し、Term側にも同じTextDocumentContentProviderパターンでプレビューを追加。既存パターンの横展開で設計判断は最小限に抑えた。→ [詳細](done/260322_tm-commit-result表示改善.md) / [詳細](done/260322_term-detect結果プレビュー追加.md)

## 2026/03/22: TM検索を行単位に分割、revise時diff対応

長いユニット全体をクエリにするとTM類似度が薄まる問題に対し、normalizeForTm後の改行分割で行ごとにTM検索する方式を導入した。hardwrap前提で段落区切り=改行。revise時はold/new正規化テキストの集合差分で変更行のみを対象にし、短文フィルタでノイズも除外。既存のTmxStore・tm-rankerは無変更で再利用できた。→ [詳細](done/260322_TM検索行単位化revise対応.md)

## 2026/03/20: mdait.json を .mdait/ に移動

mdait.jsonだけがワークスペースルートに残っていたので、他の管理ファイルと同じ`.mdait/`配下に統一した。リリース前のため互換性維持は不要と判断し、パス参照・README・docsを一括更新。レビューでensureMdaitDir()未使用の指摘を受けて修正。→ [詳細](done/260320_mdait-json-移動.md)

## 2026/03/20: TMX x-unit / x-unit-hash フィールドの削除

TMXのx-unit（ファイルパス）とx-unit-hash（ユニットハッシュ）は、provenance追跡として設計されたが「正確に保つコストに見合う使い道がない」と判断しYAGNIで削除。cleanupはtuidベースの原文現存確認で十分だった。これに伴いunitHashベースのLLMスキップ最適化も同時に廃止された。→ [詳細](done/260320_TM_x-unit削除.md)

## 2026/03/20: TM normalize処理の一元化とtrigramキャッシュ

stripMarkdownが3層に散らばって同一テキストに最大3回実行されていた問題を、normalize処理をStore/Ranker内部に閉じ込めることで解決。呼び出し側は生テキストを渡すだけにし、trigramもTmxStoreがエントリ登録時に計算・保持するフォワードキャッシュを追加した。レビューでtrigramCache.clear()漏れが見つかり修正。→ [詳細](done/260320_TM_normalize一元化.md)

## 2026/03/20: TM スコアリングエンジン langfix

TMスコアリング実装直後、ja→en翻訳でTM参照がほぼヒットしない問題が発覚。trigramIndexがprimary（en）テキストだけで構築されており、jaクエリと言語が噛み合っていなかった。インデックスをlang別に分離して修正。設計段階で「primaryを検索軸にする」前提を疑わなかったことが原因で、動かして初めて見えたバグだった。→ [詳細](done/260320_tm-scorer-langfix.review.md)

## 2026/03/20: TM スコアリングエンジン実装

TM retrievalがexact matchに頼っていたため、文面が少し変わるだけで参考訳を返せなかった。trigram転置インデックスで粗く絞り込み、Jaccard類似度で精密スコアリング、MMRで多様性を確保する2段パイプラインを採用。embeddingはAPI依存・コスト増のため将来の差し替えポイントとして保留した。→ [詳細](done/260320_tm-scorer.md)

## 2026/03/20: tm-commit 結果プレビュー

tm-commit完了後の通知が件数だけで中身が分からなかった問題を、TextDocumentContentProviderによる仮想ドキュメントプレビューで解決。固定URI+onDidChangeで既存タブを上書きする方式を採用し、ファイルシステムに残らず大量結果でも見やすい形にした。→ [詳細](done/260320_tm-commit-preview.md)

## 2026/03/20: tm-commit dual-hashスキップ最適化

tm-commitが変更なしユニットにも毎回LLMを呼んでいた問題に対し、TmVariantが言語ごとに保持するunitHashを活かしてprimary+local両方のハッシュ一致でスキップする方式を導入。過去のprimaryのみスキップの失敗を踏まえた改善で、syncやり直し時も自然に検出できることを確認した。→ [詳細](done/260320_tm-commit-hash-skip.md)

## 2026/03/16: SentenceSplitter TM登録除去

SentenceSplitterがTM検索用なのにTM登録処理でも使われていた責務違反を解消。3つの設計案を比較し、TmxStoreを「unitPathの全エントリを返す純粋データアクセス」に縮小、フィルタリングロジックをCommands層に移譲する案を採用。sentenceSplitterはTmxStoreから完全削除した。→ [詳細](done/260316_sentenceSplitter_TM登録除去.md)

## 2026/03/15: TMX補助propを廃止し保存契約を簡素化

TMXに埋め込んでいたx-primaryやx-source-hashなどの補助propを、tuid+tuv+provenanceを正本とする方針で廃止。旧TMXの読み込み互換は維持しつつ、新規保存は常に簡素な形に正規化することにした。sourceHashスキップも同時に廃止し、tm-commitをguarded upsertのみで成立させた。→ [詳細](done/260315_TMX補助prop廃止.md)

## 2026/03/15: TM登録primary基準化の総合レビュー修正

primaryLang基準tm-commitの総合レビューで、retryLimit設定導線不足やsourceHashスキップ順序退行、fail-closed不足など複数の問題が見つかった。大きな設計変更は避け局所修正で収束させる方針で、3観点並列レビューを繰り返し全件承認まで持っていった。→ [詳細](done/260315_TM登録primary総合レビュー修正.md)

## 2026/03/15: TM登録をprimaryLang基準の guarded upsert へ再設計

従来のsource/target相対なTM登録を、primary sentenceを正準キー（tuid=hash(norm(primary))）とする設計に刷新。Command層でprimaryUnit/localUnitを先に確定し、processorはguarded upsertに専念する構造に分離した。レビューでsame-file混入や旧TMX互換の問題が指摘されたが、回帰テスト追加で収束。→ [詳細](done/260315_TM登録primary基準化.md)

## 2026/03/15: primaryLang旧互換を削除してトップ階層必須に統一

直前の移設で残した旧terms.primaryLangの互換読込を削除し、top-level primaryLangだけを正とする状態に整理。旧設定の自動救済は行わず、未設定はsilent failureではなく明示的なvalidation errorにした。設定移設の仕上げとして、TM機能本体には触れない範囲で完結させた。→ [詳細](done/260315_primaryLang互換削除.md)

## 2026/03/15: primaryLangをterms配下からトップ階層へ移設

TM機能をprimaryLang基準に寄せる前提として、用語集専用のterms配下に置かれていたprimaryLangをトップ階層へ移設した。既存ユーザーを壊さないため旧キーは移行期間の互換読込として残し、top-levelを常に優先する方式にした。レビューで後方互換性不足が指摘され互換層を追加して承認。→ [詳細](done/260315_primaryLangトップ階層移設.md)

## 2026/03/15: TM正規化でinline保持とfrontmatter除外を修正

stripMarkdownでインラインコードが消えfrontmatterが混入する問題を修正。frontmatterは先頭パターンマッチで除去し、inline codeはcode_inlineトークンをバッククォート付きで保持する方式を採用。markdown-itベースの既存設計を保ったまま最小差分で対応した。→ [詳細](done/260315_tm正規化_inline保持とfrontmatter除外.md)

## 2026/03/08: tm-commitフォルダをtmフォルダに統合

同じTM機能なのにtm-commit/とtm/が並立していたのを統合し、コマンドIDもmdait.tm.commit.*に統一した。feature-tmブランチ開発中のため後方互換性リスクなし。レビューで不要export除去とロガーコンテキスト統一を指摘され修正して承認。→ [詳細](done/260308_tm-commit-into-tm.md)
