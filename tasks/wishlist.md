# wish list

## ガイドライン

**IMPORTANT**
このWishリストからタスクチケットを作成する場合は以下の手順に従うこと。

1. 該当のWishの内容を確認する（関係ないWishについて混同しないように注意）
2. `/docs`ディレクトリ以下の設計書を確認し、ユーザーとともに意図や全体との整合性が取れるまで十分な設計を行う。
3. タスクチケットを発行する
4. 本リストからは該当Wishの章を削除する

## 要望一覧

### 多言語

### 用語集翻訳のサポート

未翻訳時にまず用語集を整備したい。用語集自体の穴埋め翻訳があればよいはず

### 校正のサポート

すでに翻訳済みの翻訳ペアに対して校正をかけ、ガイドライン順守やスタイルチェックを行う機能をサポートする。

### .md以外のファイルのサポート

.md以外のテキストファイル（例: .txt, .json, .yaml .csvなど）もサポートする。
- mdと違いhtmlコメントは使えないためファイル単位で扱う必要がある
- mdaitマーカーはどこに持つのか？検討する必要がある

### 横並びファイルのtransPairのサポート

現在mdaitはja/enのように言語ごとにディレクトリを分けて翻訳ペアを管理しているが、ja.md/en.mdのように横並びでファイルを配置するケースもある。これらをサポートする。
- 両立は難しそうなので、設定で切り替えられるようにする


### Readmeへの動画追加

- Readmeにプロモーション動画を追加する

### UserGuideの作成

- UserGuideを作成し、Readmeからリンクを張る

### tm-optimize 実装

**背景・目的**
`tm-commit` によって TM が蓄積されるため、TU ごとの有用度 `x-wt` を定期再計算して retrieval 品質を維持する `tm-optimize` を実装する。

**コンセプト**
`tm-optimize` は明示実行コマンドとして提供する。sync からは呼び出さず、`sync / tm-optimize / tm-commit` の責務分離を維持する。

**設計の根拠**
- 設計仕様: [tasks/done/tm.md](tasks/done/tm.md) 6章・8.2節シーケンス図参照
- `x-wt = clamp(0.7 * corpusPresence + 0.3 * retrievalUsefulness)`
- `corpusPresence` は normalize 後 primary sentence 完全一致のみ
- `retrievalUsefulness` は既存 retrieval の top5 順位点を合算し 0..1 正規化
- `x-wt` 以外の補助メタデータは TMX に追加しない
- sync から optimize を自動呼び出ししない

**想定問答**
- Q: optimize を sync 側に混ぜればいいのでは？
  A: sync は同期責務に限定し、重み更新は明示実行に分離する方が運用と検証が明確。
- Q: sentence 完全一致ではなく fuzzy でよいのでは？
  A: 初期版は deterministic を優先し、normalize + 完全一致のみ採用する。

### `getEntriesByUnitPath` を `getEntriesForCommit` に改名

**背景・目的**
x-unit/x-unit-hash フィールド削除に伴い、`TmxStore.getEntriesByUnitPath(unitPath, localLang)` は unitPath での絞り込みをせず primaryLang を持つ全エントリを返すようになった。メソッド名と実際の動作が乖離しているため、命名を実態に合わせて改める。

**コンセプト**
`getEntriesForCommit(primaryLang: string)` のような名称に変更し、引数も実際に使われている `primaryLang` のみにする。呼び出し元（`commit-processor.ts`）も合わせて修正すること。

### TM検索クエリの文単位分割（ハイブリッドアプローチ）

**背景・目的**
TM登録時はLLMが文単位でアライメントするためTMエントリは「文」粒度だが、TM検索時は`normalizeForTm` → 改行分割で「段落/リスト項目」粒度になっている。この粒度ギャップにより、1段落に複数文を含むケース（特に論文・技術文書）でJaccardスコアが希薄化し、TM参照精度が低下する。

**コンセプト**
`splitToQueryLines` の改行分割後に `Intl.Segmenter(lang, { granularity: "sentence" })` を追加し、各行をさらに文単位に分割する。`normalizeForTm`（markdown-it経由）で改行コードが正規化されるため、既存のSentenceSplitterクラスのCRLFバグも回避できる。

chemistry.mdでの実験結果:
- 60字超のクエリ: 15件 → 7件（半減）
- 101字超のクエリ: 4件 → **0件**（全滅）
- NMRデータ等の非文テキストは正しく非分割

付随してSentenceSplitterの `split(/\n\n+/)` をCRLF対応（`/\r?\n\r?\n/`）に修正する。現在は未使用だが将来の再利用に備える。

**想定問答**
- Q: 文分割すると短すぎるクエリが増えて検索ノイズが増えない？
  A: 既存の`minQueryLength`フィルタが適用されるため、短文は除外される。また`isWorthyForTm`で登録時にも短文はフィルタされているのでTM側にも短文は少ない。
- Q: Intl.Segmenterの精度は大丈夫？
  A: 実験で確認済み。日本語の「。」区切りは正確に検出され、NMRデータのような非文テキストは分割されなかった。
- Q: SentenceSplitterクラスを使わないなら削除する？
  A: 削除する。YAGNI。
