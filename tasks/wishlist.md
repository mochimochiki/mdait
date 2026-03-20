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

### tm-commit 完了後の登録内容プレビュー

**背景・目的**  
`tm-commit` 完了後に「何が新規登録されて何が更新されたか」をサッと確認したい。現状は件数通知のみで、内容を確認するには tmx ファイルを直接開くか git diff する必要がある。

**コンセプト**  
コミット完了後、その場限りの仮想ドキュメントをエディタで開き、今回の登録/更新内容を一覧表示する。ファイルシステムには残らず、閉じたら終わり。

**表示形式イメージ**
```
# TM Commit Results - 2026-03-20 15:30

## New (3)
[NEW] "This is an introduction." → "これは導入文です。"
[NEW] "Click OK to proceed." → "OK をクリックして続行します。"
...

## Updated (1)
[UPDATE] "The file was saved." → "ファイルが保存されました。"
```

**実装ポイント**
- `TextDocumentContentProvider` で `mdait-tm-result:` スキームの仮想ドキュメントを作成
- `applyPlanItems` の戻り値に実際の文テキスト（primary/local）を含める
- 完了後 `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` で開く
- 0件の場合は開かない（件数通知のみ）

**想定問答**
- Q: git diff で見ればいいのでは？  
  A: xml は見にくい。手間がかかる。「作業完了後にすぐ確認したい」という UX 改善。
- Q: OutputChannel への追記ではダメ？  
  A: OutputChannel は流れていくので一覧確認に向かない。エディタで開くほうがサッと見て閉じやすい。
- Q: ファイルに残さなくていい？  
  A: 仮想ドキュメントなので閉じたら消える。永続化したければ tmx 本体を git 管理すればよい。

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