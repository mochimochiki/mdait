---
name: byok-shim
description: "OpenAI 互換のローカル受け皿（scripts/byok-shim）を mdait の ai.openai.baseURL に向けて、AI を使うコマンド（trans / term / tm / ai-review / adopt）を HTTP の向こう側まで含めて動かすための Skill です。実際に送っているプロンプトの観察、指示文の改稿の比較、429/500/遅延/壊れた応答を注入しての耐性確認、鍵なしでの回帰再生に使う。Use when: inspecting or improving prompt templates, comparing prompt revisions, reproducing LLM failure modes (rate limits, timeouts, malformed JSON), verifying provider-layer retry behavior, running trans end-to-end without an API key, or when test:byok:e2e fails."
---

# BYOK shim — LLM の相手を手元に立てて仕事をする

mdait の `ai.provider: "openai"` は `ai.openai.baseURL` の行き先を差し替えられる。そこへ向ける
OpenAI 互換のローカルサーバーが `scripts/byok-shim/` にある。裏に誰を据えるかを起動時に選ぶので、
「本物の LLM には注文できない場面」を毎回同じように作れる。

`fake-ai.js`（`explore-sweep`）との違いは分岐する位置である。あちらは `AIService` の実装ごと
差し替えるので HTTP より手前で分かれ、プロバイダ層（リトライ・タイムアウト・`ai-stats.log`）が
動かない。shim は HTTP の向こう側に立つので、そこまで本物が走る。

使い方の詳細は `scripts/byok-shim/README.md`。この Skill は**何をするときに、どう組み立てるか**を書く。

## いつ使うか

- `src/prompts/defaults.ts` を書き換えたい。実際に何が送られているかを見たい／改稿を比べたい
- 429・500・タイムアウト・途中で切れた JSON に mdait がどう耐えるかを確かめたい
- `npm run test:byok:e2e` が落ちた（＝プロンプトの組み立てが変わった合図）
- API キーが無い環境で `trans` を端から端まで走らせたい
- `term` / `tm` / `ai-review` / `adopt` の応答形式を実物で確認したい（すべて同じ `AIService` を通る）

## 4つの使い方

どれも先に `npm run compile` が要る（`trans-e2e.js` は `out/` を直接 require する）。
ポートは固定より `--port 0` が安全で、標準出力の1行目 `PORT=<番号>` から拾える。

### 1. 実物を見る — `--mode live`

郵便受けにファイルで答える。`digest-NNN.md` は前回からの差分だけを見せるので、
何往復しても読み手の作業記憶が尽きない。全文は `req-NNN.json` にある。

```bash
node scripts/byok-shim/shim.mjs --mode live --port 8123 --answer-timeout 900 &
node scripts/byok-shim/trans-e2e.js --shim http://127.0.0.1:8123/v1 --target en/10_test.md &
node scripts/byok-shim/wait.mjs                      # 要求が来るまで戻らない
cat scripts/byok-shim/mailbox/digest-001.md
node scripts/byok-shim/reply.mjs --next --translation "訳文をここに"
```

`--translation` は `{"translation": "..."}` に包んでから渡す。手で JSON を書くと
引用符の入れ子でほぼ必ず間違えるので、翻訳を返すときは必ずこれを使う。

### 2. 指示文の改稿を比べる — `--mode agent`

`claude -p` を1回起こして答えさせる。無人で並列に走る。

**この翻訳役は mdait を知らない**。実測で「mdait とは何か」に `I DO NOT KNOW.` と答えた。
道具を持たず（`--tools ""`）、作業場所は空のディレクトリ、`--safe-mode` で `CLAUDE.md` も読まない。
指示文は `--system-prompt` で丸ごと置き換わる。だから**指示文の出来がそのまま結果に出る**。

```bash
node scripts/byok-shim/shim.mjs --mode agent --agent-concurrency 6 --port 8123 \
     --record /tmp/before.jsonl &
node scripts/byok-shim/trans-e2e.js --shim http://127.0.0.1:8123/v1 --dir en/child --concurrency 4
# mdait.json の prompts で指示文を差し替えてから、--record 先を変えて同じことをする
```

比べていることの中身は3つに縛られる。この枠を外して結論を書かない。

- 測っているのは「その指示文 × Claude」であって指示文そのものではない。本番で別のモデルを
  使うなら、その組み合わせで測り直すことになる
- 温度や種を指定する口が無い。1回の結果で決めない
- 1依頼あたり4〜5秒、実費がかかる。対象は1〜3ファイルに絞る

**`live` は比較に使えない。** 答える側（＝あなた）が作業場の事情を知っているので、
指示文が悪くても補って答えてしまう。`live` は観察と注入のためのものである。

### 3. わざと壊す — `--mode script`

台本を順に返す。`scenarios/nasty.jsonl` に意地の悪い場面を並べてある。
`res` の鍵で振る舞いを作る: `delay`（秒だけ黙る）、`http_status`（429/500 を返す）、
`finish_reason`（`length` で途中打ち切り）、`raw_chunks`（壊れた SSE を検査せず流す）。

```bash
node scripts/byok-shim/shim.mjs --mode script \
     --script scripts/byok-shim/scenarios/nasty.jsonl --script-loop --port 8123 &
node scripts/byok-shim/trans-e2e.js --shim http://127.0.0.1:8123/v1 --target en/10_test.md
```

台本を使い切ると 409 で止まる。黙って先頭へ戻らない（`--script-loop` を渡したときだけ戻る）。

### 4. 回帰を守る — `--mode replay`

録音を再生する。LLM を呼ばないので鍵も費用も要らない。要求が録音と1文字でも違えば 409 で止まる。
突き合わせは並び順ではなく**中身**で引く（ファイル単位の並列翻訳では到着順が毎回変わるため）。

```bash
npm run test:byok:e2e     # recordings/trans-en-child.jsonl を再生。12往復・LLM 0回
```

**これが落ちたら、プロンプトの組み立てが変わったということ。** 意図した変更なら録り直す。

```bash
node scripts/byok-shim/shim.mjs --mode agent --agent-concurrency 8 --port 8123 \
     --record scripts/byok-shim/recordings/trans-en-child.jsonl &
node scripts/byok-shim/trans-e2e.js --shim http://127.0.0.1:8123/v1 --dir en/child --concurrency 4
npm run test:byok:e2e     # 録り直したもので通ることを確かめる
```

意図しない変更なら、録音との差分がそのまま原因を指している。`--record` を別ファイルに取って
`req` の中身を突き合わせる。

## 実測して分かっていること

推測ではない。同じことを調べ直す前にここを見る。

| 事実 | 効いてくる場面 |
|---|---|
| ユニットは逐次、並列はファイル単位（`trans.concurrency` 既定3・上限8） | 速度を上げたいとき。shim 側の並列度は上限にならない |
| 3ファイル9ユニット＝12往復・28.4秒（フロントマターの `title` も1往復ずつ） | 対象を絞る目安 |
| 503 と 429 は約2秒おいて送り直され、翻訳は完走する | 耐性の確認。ただし送り直しは `ai-stats.log` に現れない（1回分にまとめられ、所要時間だけ伸びる） |
| 409 は送り直されず、その場で `outcome: "failed"` | replay の不一致が「失敗」として出る理由 |
| コードブロックは `__CODE_BLOCK_PLACEHOLDER_n__` に置換されて送られる | 返す答えでこの目印をそのまま返さないと本文が落ちる |
| mdait は `/v1/models` を叩かない | 実装してあるが、mdait の検証では使われない |

## 落とし穴

- **共有 `src/test/unit/workspace/.mdait/mdait.json` を書き換える。** `trans-e2e.js` は終了時に
  必ず元へ戻すが、`--keep` を渡したときだけ戻さない。`--keep` を使ったら自分で
  `git checkout -- src/test/unit/workspace/.mdait/mdait.json` すること。
- **`pkill -f byok-shim` は自分のシェルごと巻き込む**（コマンド行にその文字列が入るため）。
  バックグラウンド起動はジョブ番号か PID で止める。
- **commands 層はタイマーと watcher を残すので、待っていてもプロセスが終わらない。**
  `trans-e2e.js` は明示的に `process.exit(0)` している。新しく駆動役を書くときも同じにする。
- **`--mode live` の待ち時間はそのまま HTTP のタイムアウトに乗る。** `mdait.json` の
  `ai.openai.timeoutSec` を長めにしないと、考えている間に mdait 側が諦める。
- `--record` に秘密は残らない（`Authorization` の値は伏せ字になる）。ただし要求の全文は残るので、
  原稿そのものを見せたくない場合は録音を配らない。

## 規律

- 「動いた」と書くのは、実際に動かして出力を見たときだけ。shim の出力を読まずに結論を書かない。
- 指示文を変えたら `npm run test:byok:e2e` を回す。落ちたら**録り直すか、変更を戻すかを決めてから**進む。
  黙って録音を上書きしない — 何が変わったのかを先に説明できるようにする。
- 実費がかかる。`--mode agent` を回す前に対象ファイル数と往復回数を見積もる。
- `npm test`（単体＋shim の29件）と `npm run test:explore` を緑にしてからコミットする。

## 参照

- 道具の使い方: `scripts/byok-shim/README.md`
- テスト戦略の中での位置づけ: `docs/design/test.md`
- 決定の経緯と実測値: `docs/adr.md` の ADR-260822-03
- プロバイダ層の実装: `src/infra/llm/providers/openai-provider.ts`、`src/infra/llm/retry.ts`
- 指示文のテンプレート: `src/prompts/defaults.ts`、分割の考え方は `docs/design/prompt.md`
