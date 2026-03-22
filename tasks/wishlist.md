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

### sync時のTMクリーンアップ実装

**背景・目的**
`tm-commit` によって TM が蓄積されていく一方、sync 時に削除・改訂された primaryLang のユニットに対応する obsolete な TU が TM に残り続ける。これを定期的に除去する機能（TM cleanup）が未実装なので実装する。

**コンセプト**
sync 後のポストプロセスとして TM cleanup を呼び出す。cleanup は「primary sentence がまだ原稿に存在するか」だけを判定軸にして obsolete TU を削除する。sync / cleanup / tm-commit の責務分離を維持すること（tm.md 6.3節参照）。

**設計の根拠**
- 設計仕様: [tasks/done/tm.md](tasks/done/tm.md) 6章・8.2節シーケンス図参照
- cleanup は 2 段階判定: (1) unit情報から削除候補を抽出、(2) primary sentence の現存性を照合
- 照合は normalize + 完全一致（`tm-text-normalizer.ts` 流用）
- cleanup 呼び出しは `sync_CoreProc` の外、`flushBuffer()` 後のポストプロセスとして追加
- primaryLang の changed/modified/removed ユニットのみが候補抽出の対象
- `TmxStore` に削除メソッド（`removeByTuid`）を追加する必要あり

**想定問答**
- Q: cleanup しないと何が困る？
  A: 翻訳時の TM 参照でノイズが増える。削除・改訂済みの古い訳が参考例として出てきてしまう。
- Q: cleanup を tm-commit 側に混ぜればいいのでは？
  A: tm-commit は「new を登録するまで」が責務。混ぜると責務が曖昧になり、cleanup だけ独立してテストしにくくなる。
- Q: sentence 完全一致ではなく fuzzy でよいのでは？
  A: 誤削除のリスクがあるため、normalize + 完全一致を基準とする。

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
