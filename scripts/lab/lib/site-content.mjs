/*
 * 規模のある見本サイトの中身（対訳の原稿そのもの）。
 *
 * ここに置くのは「人が訳した既存サイト」の見本である。マーカーは1つも書かない
 * （取り込み＝adopt は、マーカーの無い対訳を管理下に載せる操作なので、
 * 見本にマーカーがあると測りたいものが測れなくなる）。
 *
 * 単体テストの見本（src/test/unit/sample-content）はわざと小さく保つ設計なので、
 * 規模のあるものはそちらへ置かず、ここから生成する。
 *
 * 章の構成の作り分けは kind で言う。docs/design/command_adopt.md のパターン表に対応する:
 *   aligned        : 構造も内容も対応している（パターン1）
 *   missingSection : 訳文で中間の章が1つ落ちている（パターン2）
 *   reordered      : 訳文で章の順序が入れ替わっている（パターン4）
 *   targetExtra    : 原文に無い章が訳文にある（パターン3）
 *   sourceOnly     : 訳文ファイルがまだ無い（パターン7）
 *   targetOnly     : 原文に無い訳文ファイル（パターン8・既知の限界）
 */

/** 章を1つ作る。lead が true ならその章は H1（ページの導入） */
function s(hJa, hEn, bJa, bEn) {
	return { h: { ja: hJa, en: hEn }, b: { ja: bJa, en: bEn } };
}

/**
 * Markdown のページ。
 * sections[0] は H1（ページの導入）、以降は H2。
 * 章の作り分け（欠落・入れ替え・訳文だけの章）は H2 の側だけに効かせる。
 */
export const PAGES = [
	{
		path: "_index.md",
		kind: "aligned",
		weight: 1,
		fm: {
			ja: [
				"date: 2025-03-04",
				"draft: false",
				"keywords: [ノート, 共有, チーム]",
				"summary: |",
				"  チームでノートを共有するためのサービスです。",
				"  この手引きは導入から日々の操作までを扱います。",
			],
			en: [
				"date: 2025-03-04",
				"draft: false",
				"keywords: [notes, sharing, team]",
				"summary: |",
				"  A service for sharing notes across a team.",
				"  This guide covers everything from installing it to daily use.",
			],
		},
		title: { ja: "クモノート ドキュメント", en: "Kumo Note Documentation" },
		description: {
			ja: "チームでノートを共有するためのサービスの手引き。",
			en: "A guide to the service for sharing notes across a team.",
		},
		sections: [
			s(
				"クモノートとは",
				"What Is Kumo Note",
				"クモノートは、チームで書いたノートを1か所に集めて共有するサービスです。書いた内容はすぐに全員へ届き、あとから探して取り出せます。",
				"Kumo Note is a service that gathers the notes your team writes in one place and shares them. What you write reaches everyone right away, and you can find it again later.",
			),
			s(
				"できること",
				"What You Can Do",
				"ノートの作成と編集、タグによる整理、全文検索、チーム内での共有ができます。有料の契約では、変更の履歴と外部サービスとのつなぎ込みが加わります。",
				"You can create and edit notes, organize them with tags, search their full text, and share them within your team. Paid plans add change history and connections to outside services.",
			),
			s(
				"この手引きの読み方",
				"How to Read This Guide",
				"はじめて使う方は「導入する」から順に読んでください。すでに使っている方は、必要な章だけを拾い読みできます。",
				"If you are new here, read from Installing onward in order. If you already use the service, you can dip into just the chapters you need.",
			),
		],
	},
	{
		// 章の索引ページ（静的サイトジェネレータでいう branch bundle）。実サイトには必ずある形で、
		// 本文が短く、リンクの一覧が主になる。
		path: "guide/_index.md",
		kind: "aligned",
		weight: 19,
		quote: "none",
		title: { ja: "使い方", en: "Guide" },
		description: { ja: "日々の操作をひととおり。", en: "The day-to-day operations, end to end." },
		fm: {
			ja: ["draft: false", "date: 2025-03-04", "tags:", "  - 使い方", "  - 手引き"],
			en: ["draft: false", "date: 2025-03-04", "tags:", "  - guide", "  - handbook"],
		},
		sections: [
			s(
				"使い方",
				"Guide",
				"ノートを書く・整理する・探す・共有する。日々の操作はこの章にまとまっています。",
				"Writing, organizing, finding, and sharing notes. The day-to-day operations are collected in this chapter.",
			),
			s(
				"この章の中身",
				"What Is in This Chapter",
				[
					"1. [ノートを扱う](notes/) — 編集・複製・削除",
					"2. [タグで整理する](tags/) — タグの付け方と絞り込み",
					"3. [探す](search/) — 全文検索と絞り込みの記号",
					"4. [同期のしくみ](sync/) — 複数の端末で同じノートを見る",
					"5. [共有する](share/) — 範囲と権限",
					"6. [控えを取る](backup/) — 手元へ書き出す",
				].join("\n"),
				[
					"1. [Working with Notes](notes/) — editing, duplicating, deleting",
					"2. [Organizing with Tags](tags/) — applying tags and filtering",
					"3. [Searching](search/) — full-text search and filter syntax",
					"4. [How Syncing Works](sync/) — the same notes on several devices",
					"5. [Sharing](share/) — scope and permissions",
					"6. [Backing Up](backup/) — exporting to your own machine",
				].join("\n"),
			),
		],
	},
	{
		path: "start/install.md",
		kind: "aligned",
		crlf: true,
		weight: 10,
		quote: "single",
		fm: ["date: 2025-01-20", "draft: false"],
		title: { ja: "導入する", en: "Installing" },
		description: {
			ja: "クモノートを手元の環境に入れる手順。",
			en: "Steps for installing Kumo Note in your environment.",
		},
		sections: [
			s(
				"導入する",
				"Installing",
				"手元の環境にクモノートを入れて、チームのノートを読めるようにするまでを説明します。所要時間は10分ほどです。",
				"This chapter covers everything from installing Kumo Note on your machine to reading your team's notes. It takes about ten minutes.",
			),
			s(
				"動作環境",
				"System Requirements",
				"Windows 11、macOS 14 以降、Ubuntu 22.04 以降で動きます。メモリは 4 GB 以上、空き容量は 500 MB 以上が必要です。",
				"It runs on Windows 11, macOS 14 or later, and Ubuntu 22.04 or later. You need at least 4 GB of memory and 500 MB of free space.",
			),
			s(
				"入手する",
				"Getting the Installer",
				"公式サイトの配布ページから、お使いの環境に合ったものを選んで受け取ってください。社内で配っている場合は、管理者から渡された版を使います。",
				"Choose the build that matches your environment on the download page of the official site. If your company distributes it internally, use the build your administrator gives you.",
			),
			s(
				"入れ終わったら",
				"After Installing",
				"起動すると、最初にサインインの画面が出ます。招待のメールに書かれた合言葉を入れると、チームのノートが読めるようになります。",
				"When you start it, a sign-in screen appears first. Enter the passphrase written in your invitation email and you will be able to read your team's notes.",
			),
		],
	},
	{
		path: "start/first-note.md",
		kind: "aligned",
		weight: 11,
		title: { ja: "最初のノートを書く", en: "Writing Your First Note" },
		description: {
			ja: "ノートを1本書いて、共有するまで。",
			en: "From writing a single note to sharing it.",
		},
		sections: [
			s(
				"最初のノートを書く",
				"Writing Your First Note",
				"導入が済んだら、まず1本書いてみるのがいちばん早い理解の道です。ここでは作成から共有までを一通りたどります。",
				"Once you have installed it, writing a single note is the fastest way to understand the service. This chapter walks through everything from creating a note to sharing it.",
			),
			s(
				"新しいノートを作る",
				"Creating a New Note",
				"左上の「新規」を押すと、白紙のノートが開きます。1行目に書いた文字が、そのままノートの題名になります。",
				"Press New at the top left and a blank note opens. Whatever you type on the first line becomes the note's title.",
			),
			s(
				"書き方",
				"How to Write",
				"本文は Markdown で書けます。見出し・箇条書き・表・コードのどれも、書いたそばから整った形で表示されます。",
				"You can write the body in Markdown. Headings, bullet lists, tables, and code all appear in their finished form as you type.",
			),
			s(
				"共有する",
				"Sharing",
				"右上の「共有」を押すと、チームの全員が読めるようになります。特定の人にだけ見せたいときは、共有する相手を選び直してください。",
				"Press Share at the top right and everyone on your team can read it. If you want only certain people to see it, change who it is shared with.",
			),
		],
	},
	{
		path: "start/import.md",
		kind: "aligned",
		weight: 12,
		title: { ja: "今あるノートを持ち込む", en: "Bringing In Existing Notes" },
		description: {
			ja: "他のサービスで書いたノートを取り込む。",
			en: "Importing notes written in other services.",
		},
		sections: [
			s(
				"今あるノートを持ち込む",
				"Bringing In Existing Notes",
				"他のサービスで書きためたノートは、まとめて取り込めます。取り込んだあとも、元のサービスのノートはそのまま残ります。",
				"Notes you have written in other services can be imported all at once. The originals stay where they are after the import.",
			),
			s(
				"取り込める形式",
				"Formats You Can Import",
				"Markdown・プレーンテキスト・HTML の3つを取り込めます。画像は本文と同じ場所へ置かれ、リンクは自動で貼り直されます。",
				"You can import Markdown, plain text, and HTML. Images are placed alongside the body, and links are re-pointed automatically.",
			),
			s(
				"取り込みの手順",
				"Import Steps",
				[
					"設定画面の「取り込み」から、ノートの入ったフォルダーを選びます。",
					"",
					"1. 設定画面を開く",
					"2. 「取り込み」を選ぶ",
					"3. ノートの入ったフォルダーを指す",
					"4. 件数を確かめて「はじめる」を押す",
					"",
					"件数が多いときは時間がかかるので、終わるまで待ってください。",
				].join("\n"),
				[
					"Choose the folder that holds your notes from Import in the settings screen.",
					"",
					"1. Open the settings screen",
					"2. Choose Import",
					"3. Point at the folder holding your notes",
					"4. Check the count and press Start",
					"",
					"It takes a while when there are many notes, so wait until it finishes.",
				].join("\n"),
			),
		],
	},
	{
		path: "guide/notes.md",
		kind: "aligned",
		crlf: true,
		weight: 20,
		title: { ja: "ノートを扱う", en: "Working with Notes" },
		description: {
			ja: "ノートの編集・複製・削除。",
			en: "Editing, duplicating, and deleting notes.",
		},
		sections: [
			s(
				"ノートを扱う",
				"Working with Notes",
				"日々の操作はこの章にまとまっています。どれも取り消しがきくので、気軽に試してください。",
				"This chapter collects the operations you use day to day. All of them can be undone, so try them freely.",
			),
			s(
				"編集する",
				"Editing",
				[
					"ノートを開いて本文をそのまま書き換えると、数秒ごとに自動で保存されます。**保存の操作は要りません**。",
					"",
					"> 書きかけのまま閉じても失われません。次に開いたとき、そのまま続きから書けます。",
					"",
					"直前の状態へ戻すには `Ctrl + Z`、やり直すには `Ctrl + Shift + Z` を押してください。",
				].join("\n"),
				[
					"Open a note and edit the body directly; it saves automatically every few seconds. **There is no save command to press.**",
					"",
					"> Closing a note mid-sentence loses nothing. Open it again and pick up where you left off.",
					"",
					"Press `Ctrl + Z` to step back and `Ctrl + Shift + Z` to step forward again.",
				].join("\n"),
			),
			s(
				"複製と移動",
				"Duplicating and Moving",
				"ノートの右端のメニューから、複製と移動ができます。移動しても、そのノートへ貼られているリンクは切れません。",
				"The menu at the right edge of a note lets you duplicate and move it. Links pointing to the note keep working after a move.",
			),
			s(
				"消す",
				"Deleting",
				"消したノートは30日間ごみ箱に残ります。その間なら、いつでも元の場所へ戻せます。",
				"Deleted notes stay in the trash for 30 days. During that time you can restore them to where they were at any point.",
			),
		],
	},
	{
		path: "guide/tags.md",
		kind: "missingSection",
		crlf: true,
		weight: 21,
		title: { ja: "タグで整理する", en: "Organizing with Tags" },
		description: {
			ja: "タグの付け方と絞り込み方。",
			en: "How to apply tags and filter by them.",
		},
		sections: [
			s(
				"タグで整理する",
				"Organizing with Tags",
				"ノートが増えてきたら、フォルダーではなくタグで整理するほうが探しやすくなります。1本のノートに何個でも付けられます。",
				"As your notes pile up, tags make them easier to find than folders do. You can attach as many tags as you like to a single note.",
			),
			s(
				"タグを付ける",
				"Adding Tags",
				[
					"本文のどこかに半角の # に続けて言葉を書くと、そのままタグになります。付け方は3通りあります。",
					"",
					"- 本文に直接書く",
					"  - 半角の # に続けて言葉を書く",
					'  - 空白を含めたいときは `#"打ち合わせ 議事録"` のように囲む',
					"- 題名の下の欄から選ぶ",
					"  - よく使うものが上に並ぶ",
					"  - 新しい言葉を入れると、その場で作られる",
					"- 一覧の画面からまとめて付ける",
				].join("\n"),
				[
					"Type a word after a hash mark anywhere in the body and it becomes a tag. There are three ways to apply one.",
					"",
					"- Write it in the body",
					"  - Type a word after a hash mark",
					'  - To include a space, wrap it as `#"meeting notes"`',
					"- Pick it from the field under the title",
					"  - The ones you use often come first",
					"  - Typing a new word creates it on the spot",
					"- Apply them in bulk from the list screen",
				].join("\n"),
			),
			s(
				"タグを並べ替える",
				"Reordering Tags",
				"左側の一覧では、よく使うタグを上へ引き上げられます。並びはチーム全員で共通ではなく、各自の画面にだけ効きます。",
				"In the list on the left you can drag the tags you use often to the top. The order is not shared with your team; it applies only to your own screen.",
			),
			s(
				"タグで絞り込む",
				"Filtering by Tag",
				"タグを押すと、そのタグの付いたノートだけが並びます。2つ以上を押せば、すべてに当てはまるノートへ絞り込めます。",
				"Press a tag and only the notes carrying it are listed. Press two or more and the list narrows to notes that match all of them.",
			),
		],
	},
	{
		path: "guide/search.md",
		kind: "reordered",
		weight: 22,
		title: { ja: "探す", en: "Searching" },
		description: { ja: "全文検索と絞り込みの書き方。", en: "Full-text search and filter syntax." },
		sections: [
			s(
				"探す",
				"Searching",
				"書いたものは、題名だけでなく本文からも探せます。検索は打ち込んだそばから結果が変わります。",
				"You can search the body of your notes, not just their titles. Results update as you type.",
			),
			s(
				"全文検索",
				"Full-Text Search",
				"上の欄に言葉を入れると、本文に含むノートが新しい順に並びます。二重引用符で囲むと、その並びのままの語句を探します。",
				"Type a word in the field at the top and notes containing it are listed newest first. Wrap it in double quotes to search for that exact phrase.",
			),
			s(
				"絞り込みの記号",
				"Filter Syntax",
				[
					"`tag:` に続けてタグ名を、`from:` に続けて日付を書くと、その条件で絞り込めます。",
					"条件は空白で区切っていくつでも並べられます。",
					"",
					"タグそのものの付け方は [タグで整理する](../tags/) を、",
					"保存の仕方は[この下の章](#よく使う検索を保存する)をご覧ください。",
				].join("\n"),
				[
					"Write a tag name after `tag:` or a date after `from:` to narrow the results.",
					"Separate as many conditions as you like with spaces.",
					"",
					"For applying tags themselves see [Organizing with Tags](../tags/), and",
					"for keeping a search see [the chapter below](#saving-searches-you-use-often).",
				].join("\n"),
			),
			s(
				"よく使う検索を保存する",
				"Saving Searches You Use Often",
				"検索の結果の右上から、その条件に名前を付けて残せます。保存した検索は左側の一覧に並び、押せばいつでも呼び出せます。",
				"From the top right of the results you can name a set of conditions and keep it. Saved searches appear in the list on the left and can be recalled at any time.",
			),
		],
	},
	{
		path: "guide/sync.md",
		kind: "aligned",
		weight: 23,
		title: { ja: "同期のしくみ", en: "How Syncing Works" },
		description: {
			ja: "複数の端末で同じノートを見るための仕組み。",
			en: "The mechanism that shows the same notes on several devices.",
		},
		sections: [
			s(
				"同期のしくみ",
				"How Syncing Works",
				"同じ合言葉でサインインしていれば、どの端末からでも同じノートが見えます。同期は自動で、操作は要りません。",
				"As long as you sign in with the same passphrase, you see the same notes from any device. Syncing is automatic and needs no action from you.",
			),
			s(
				"つながっていないとき",
				"When You Are Offline",
				[
					"通信できないあいだも、ノートの読み書きはそのまま続けられます。",
					"つながり直した時点で、書いた内容がまとめて送られます。",
					"",
					"{{< note >}}",
					"端末を替えるときは、**つながった状態で**閉じてください。",
					"送りきる前に電源を落とすと、次に開くまで反映されません。",
					"{{< /note >}}",
				].join("\n"),
				[
					"You can keep reading and writing notes while you have no connection.",
					"Once you are back online, everything you wrote is sent at once.",
					"",
					"{{< note >}}",
					"When you switch devices, close the app **while you are online**.",
					"Powering off before everything is sent delays it until you open the app again.",
					"{{< /note >}}",
				].join("\n"),
			),
			s(
				"衝突したとき",
				"When Changes Collide",
				"同じ段落を2人が同時に書き換えると、両方の内容を並べて残します。どちらを採るかは、あとから人が選びます。",
				"If two people rewrite the same paragraph at the same time, both versions are kept side by side. A person decides later which one to keep.",
			),
		],
	},
	{
		path: "guide/share.md",
		kind: "targetExtra",
		weight: 24,
		title: { ja: "共有する", en: "Sharing" },
		description: { ja: "共有の範囲と権限の決め方。", en: "Choosing who can see a note and what they can do." },
		sections: [
			s(
				"共有する",
				"Sharing",
				"ノートは既定でチームの全員が読めます。範囲は1本ごとに変えられます。",
				"By default every member of your team can read a note. You can change the scope for each note.",
			),
			s(
				"共有の範囲",
				"Who Can See It",
				"「チーム全員」「選んだ人だけ」「自分だけ」の3つから選べます。あとから変えても、それまでの履歴は消えません。",
				"You can choose from the whole team, only selected people, or yourself alone. Changing it later does not erase the history so far.",
			),
			s(
				"読み書きの権限",
				"Read and Write Permissions",
				[
					"共有した相手ごとに、読むだけか書き換えてよいかを決められます。  ",
					"書き換えを許した相手も、ノートを消すことはできません。  ",
					"消せるのは、そのノートを作った本人と、チームの管理者だけです。",
				].join("\n"),
				[
					"For each person you share with, you decide whether they can only read or may also edit.  ",
					"Even people allowed to edit cannot delete the note.  ",
					"Only the person who created it and the team administrator can delete it.",
				].join("\n"),
			),
		],
		// 原文に無い章（訳文の側だけにある独自の章）
		targetExtraSection: {
			h: "Sharing Outside Your Organization",
			b: "Guests outside your organization can be invited with a link that expires after seven days. This option is available on the English site only; ask your administrator before using it.",
			at: 2,
		},
	},
	{
		path: "guide/backup.md",
		kind: "aligned",
		weight: 25,
		title: { ja: "控えを取る", en: "Backing Up" },
		description: { ja: "ノートを手元に書き出して残す。", en: "Exporting your notes and keeping them locally." },
		sections: [
			s(
				"控えを取る",
				"Backing Up",
				"ノートは自動で保管されていますが、手元にも控えを残せます。契約を終えたあとに読み返したいときのための備えです。",
				"Your notes are stored for you automatically, but you can also keep a copy locally. It is there for when you want to read them again after your contract ends.",
			),
			s(
				"書き出す",
				"Exporting",
				[
					"設定画面の「書き出し」から、すべてのノートを Markdown のファイルとして受け取れます。",
					"画像も同じ場所へ入ります。",
					"",
					'![書き出しの画面](/images/export.png "書き出しの画面")',
					"",
					"書き出したファイルの並びは [仕様の一覧](https://example.com/spec/export) に載せています。",
				].join("\n"),
				[
					"From Export in the settings screen you can receive all of your notes as Markdown files.",
					"Images are placed in the same folder.",
					"",
					'![The export screen](/images/export.png "The export screen")',
					"",
					"The layout of the exported files is documented in the [specification](https://example.com/spec/export).",
				].join("\n"),
			),
			s(
				"戻す",
				"Restoring",
				"書き出したフォルダーをそのまま取り込めば、元の状態へ戻せます。同じ題名のノートがある場合は、新しいほうが残ります。",
				"Import the exported folder as it is and you are back where you were. Where two notes share a title, the newer one is kept.",
			),
		],
	},
	{
		path: "reference/shortcuts.md",
		kind: "aligned",
		weight: 30,
		title: { ja: "キーボードの割り当て", en: "Keyboard Shortcuts" },
		description: { ja: "よく使う操作の割り当て一覧。", en: "A list of shortcuts for common operations." },
		sections: [
			s(
				"キーボードの割り当て",
				"Keyboard Shortcuts",
				"マウスに持ち替えずに済むよう、よく使う操作には割り当てがあります。割り当ては設定画面で変えられます。",
				"Common operations have shortcuts so that you never have to reach for the mouse. You can change them in the settings screen.",
			),
			s(
				"一覧",
				"The List",
				[
					"| 操作 | Windows / Linux | macOS |",
					"| --- | --- | --- |",
					"| 新しいノート | Ctrl + N | Cmd + N |",
					"| 探す | Ctrl + K | Cmd + K |",
					"| 共有する | Ctrl + Shift + S | Cmd + Shift + S |",
					"| ごみ箱へ入れる | Ctrl + Delete | Cmd + Delete |",
				].join("\n"),
				[
					"| Operation | Windows / Linux | macOS |",
					"| --- | --- | --- |",
					"| New note | Ctrl + N | Cmd + N |",
					"| Search | Ctrl + K | Cmd + K |",
					"| Share | Ctrl + Shift + S | Cmd + Shift + S |",
					"| Move to trash | Ctrl + Delete | Cmd + Delete |",
				].join("\n"),
			),
		],
	},
	{
		path: "reference/plugins.md",
		kind: "missingSection",
		weight: 31,
		title: { ja: "拡張を足す", en: "Adding Extensions" },
		description: { ja: "拡張の入れ方と作り方。", en: "Installing and building extensions." },
		sections: [
			s(
				"拡張を足す",
				"Adding Extensions",
				"標準の機能で足りないところは、拡張で補えます。拡張はチーム単位で入れ、全員に同じものが行き渡ります。",
				"Where the built-in features fall short, extensions fill the gap. Extensions are installed per team, so everyone gets the same set.",
			),
			s(
				"入れる",
				"Installing",
				"設定画面の「拡張」から一覧を開き、必要なものを選びます。入れた直後から、再起動なしで使えます。",
				"Open the list from Extensions in the settings screen and choose what you need. They work right away, with no restart.",
			),
			s(
				"作る",
				"Building Your Own",
				[
					"拡張は JavaScript で書きます。ノートの読み書きと画面への追加ができ、",
					"外部への通信は管理者の許可が要ります。",
					"",
					"~~~js",
					"// # ここは見出しではありません（コードブロックの中の飾り）",
					"// <!-- mdait hash from:00000000 need:translate --> も、ただの文字列です",
					"export function activate(app) {",
					"\tapp.onNoteOpen((note) => {",
					"\t\tconsole.log(`開いたノート: ${note.title}`);",
					"\t});",
					"}",
					"~~~",
				].join("\n"),
				[
					"Extensions are written in JavaScript. They can read and write notes and add to the screen;",
					"talking to the outside requires an administrator's permission.",
					"",
					"~~~js",
					"// # This is not a heading (it is decoration inside a code block)",
					"// <!-- mdait hash from:00000000 need:translate --> is just a string here too",
					"export function activate(app) {",
					"\tapp.onNoteOpen((note) => {",
					"\t\tconsole.log(`Opened note: ${note.title}`);",
					"\t});",
					"}",
					"~~~",
				].join("\n"),
			),
			s(
				"外す",
				"Removing",
				"一覧から外すと、その拡張が作ったものも一緒に消えます。ノートの本文は消えません。",
				"Removing an extension from the list also deletes what it created. The body of your notes is left untouched.",
			),
		],
	},
	{
		path: "reference/api.md",
		kind: "aligned",
		weight: 32,
		fm: ["date: 2025-02-11", "aliases: [/old/api/]"],
		// 題名にコロンが入る。**裸で書くと YAML として壊れる**ので、引用符を落とすことは許されない。
		title: { ja: "外から呼ぶ: HTTP の口", en: "Calling from Outside: The HTTP API" },
		description: { ja: "HTTP でノートを読み書きする。", en: "Reading and writing notes over HTTP." },
		sections: [
			s(
				"外から呼ぶ",
				"Calling from Outside",
				"社内の別の仕組みからノートを読み書きしたいときは、HTTP の口を使います。呼び出しには鍵が要ります。",
				"When another system inside your company needs to read or write notes, use the HTTP endpoint. Calls require a key.",
			),
			s(
				"呼び方",
				"How to Call It",
				[
					"鍵は設定画面で作り、見出しに載せて送ります。",
					"",
					"```bash",
					'curl -H "Authorization: Bearer $KUMO_TOKEN" \\',
					"     https://api.example.com/v1/notes",
					"```",
				].join("\n"),
				[
					"Create the key in the settings screen and send it in a header.",
					"",
					"```bash",
					'curl -H "Authorization: Bearer $KUMO_TOKEN" \\',
					"     https://api.example.com/v1/notes",
					"```",
				].join("\n"),
			),
			s(
				"呼べる回数",
				"Rate Limits",
				"1つの鍵につき、1分あたり60回まで呼べます。超えたときは429が返るので、少し待ってから呼び直してください。",
				"Each key may be used up to 60 times per minute. Past that you get a 429, so wait a moment and call again.",
			),
		],
	},
	{
		path: "faq/troubleshooting.md",
		kind: "aligned",
		weight: 40,
		title: { ja: "うまくいかないとき", en: "When Things Go Wrong" },
		description: { ja: "よくある症状と手当て。", en: "Common symptoms and what to do about them." },
		sections: [
			s(
				"うまくいかないとき",
				"When Things Go Wrong",
				"まず試すことをここにまとめました。直らないときは、最後の章の連絡先へ知らせてください。",
				"This chapter lists the first things to try. If none of them helps, write to the contact in the last chapter.",
			),
			s(
				"サインインできない",
				"You Cannot Sign In",
				[
					"合言葉を3回間違えると、15分のあいだ受け付けなくなります。<br>",
					"時間を置いても入れないときは、管理者に招待をやり直してもらってください。",
					"",
					"<details>",
					"<summary>それでも入れないとき</summary>",
					"",
					"社内の通信の設定で、サインインの行き先だけが遮られていることがあります。",
					"管理者に <code>auth.example.com</code> への通信を確かめてもらってください。",
					"",
					"</details>",
				].join("\n"),
				[
					"After three wrong passphrases, sign-in is refused for fifteen minutes.<br>",
					"If waiting does not help, ask your administrator to send the invitation again.",
					"",
					"<details>",
					"<summary>Still cannot get in</summary>",
					"",
					"Your company network may be blocking the sign-in endpoint alone.",
					"Ask your administrator to check that <code>auth.example.com</code> is reachable.",
					"",
					"</details>",
				].join("\n"),
			),
			s(
				"ノートが古いまま",
				"Notes Look Out of Date",
				"同期が止まっているおそれがあります。画面の右下の印を押して、最後に同期した時刻を確かめてください。",
				"Syncing may have stopped. Press the indicator at the bottom right of the screen and check when it last synced.",
			),
			s(
				"動きが遅い",
				"It Feels Slow",
				"ノートが1万本を超えると、検索に時間がかかることがあります。使っていないノートを別のチームへ移すと軽くなります。",
				"Once you pass ten thousand notes, searching can take a while. Moving notes you no longer use to another team makes it lighter.",
			),
		],
	},
	{
		path: "faq/billing.md",
		kind: "missingSection",
		weight: 41,
		title: { ja: "料金と支払い", en: "Pricing and Payment" },
		// 説明が角括弧で始まる。**裸で書くと YAML が配列として読み直す**（文字列でなくなる）。
		description: { ja: "[重要] 契約の種類と支払いの流れ。", en: "[Important] Plan types and how payment works." },
		sections: [
			s(
				"料金と支払い",
				"Pricing and Payment",
				"契約は人数ごとの月額です。途中で人数が増えた分は、その月の日割りで計算します。",
				"You are billed monthly per person. If the number of people grows mid-month, the difference is prorated for that month.",
			),
			s(
				"契約の種類",
				"Plan Types",
				[
					"無料・標準・上位の3つがあります。",
					"",
					"| 契約 | 月額 | ノートの上限 | 備考 |",
					"| :--- | ---: | :---: | --- |",
					"| 無料 | 0 円 | 1000 本 | |",
					"| 標準 | 800 円 | 上限なし | 変更の履歴が付く |",
					"| 上位 | 1,600 円 | 上限なし | 外部との連携（`読み` \\| `書き`）が付く |",
				].join("\n"),
				[
					"There are three plans: free, standard, and premium.",
					"",
					"| Plan | Monthly | Note limit | Notes |",
					"| :--- | ---: | :---: | --- |",
					"| Free | $0 | 1,000 | |",
					"| Standard | $8 | none | adds change history |",
					"| Premium | $16 | none | adds outside connections (`read` \\| `write`) |",
				].join("\n"),
			),
			s(
				"支払いの方法",
				"Payment Methods",
				"クレジットカードと銀行振込を選べます。振込を選んだ場合は、請求書を月末に送ります。",
				"You can pay by credit card or bank transfer. If you choose transfer, we send an invoice at the end of the month.",
			),
			s(
				"やめるとき",
				"Cancelling",
				"設定画面からいつでも解約できます。解約したあと90日間は、書き出しのためにノートを残しておきます。",
				"You can cancel at any time from the settings screen. For ninety days after cancelling, your notes are kept so that you can export them.",
			),
		],
	},
	{
		path: "faq/security.md",
		kind: "targetExtra",
		weight: 42,
		title: { ja: "安全の話", en: "Security" },
		description: { ja: "預かった内容の扱い方。", en: "How we handle what you entrust to us." },
		sections: [
			s(
				"安全の話",
				"Security",
				"預かったノートをどう守っているかを説明します。詳しい取り決めは利用規約にあります。",
				"This chapter explains how we protect the notes you entrust to us. The detailed terms are in the terms of use.",
			),
			s(
				"通信と保管",
				"In Transit and at Rest",
				[
					"通信はすべて暗号化しています（TLS 1.3・AES-256-GCM）。",
					"保管する側でも暗号化しており、鍵はノートの内容とは**別の場所**に置いています。",
					"",
					"- 🔒 通信中 … TLS 1.3",
					"- 🗄️ 保管中 … AES-256-GCM",
					"- 🔑 鍵の保管 … 別系統（鍵の入れ替えは 90 日ごと）",
					"",
					"合言葉は 12 文字以上（英字＋数字＋記号のうち 2 種類以上）を必須にしています。",
				].join("\n"),
				[
					"All communication is encrypted (TLS 1.3, AES-256-GCM).",
					"Stored data is encrypted as well, and the keys are held **somewhere separate** from the note contents.",
					"",
					"- 🔒 In transit — TLS 1.3",
					"- 🗄️ At rest — AES-256-GCM",
					"- 🔑 Key storage — a separate system (keys rotate every 90 days)",
					"",
					"Passphrases must be at least 12 characters and mix at least two of letters, digits, and symbols.",
				].join("\n"),
			),
			s(
				"誰が見られるか",
				"Who Can See It",
				"運営側がノートの中身を読むことはありません。障害の調査で必要なときは、事前にチームの管理者へ知らせます。",
				"We do not read the contents of your notes. If an incident investigation requires it, we notify your team's administrator beforehand.",
			),
		],
		targetExtraSection: {
			h: "Reporting a Vulnerability",
			b: "If you find a security problem, write to security@example.com rather than opening a public issue. We reply within three business days and credit reporters who wish to be named.",
			at: 3,
		},
	},
	{
		path: "policy/terms.md",
		kind: "reordered",
		weight: 50,
		title: { ja: "利用規約", en: "Terms of Use" },
		description: { ja: "サービスを使ううえでの取り決め。", en: "The agreement for using the service." },
		sections: [
			s(
				"利用規約",
				"Terms of Use",
				"このサービスを使う方には、以下の取り決めに同意していただきます。内容は予告して変えることがあります。",
				"Everyone who uses this service agrees to the terms below. We may change them with prior notice.",
			),
			s(
				"できないこと",
				"What You May Not Do",
				[
					"法に触れる内容や、他人の権利を侵す内容を置くことはできません[^1]。",
					"見つけた場合は、予告なくノートを止めることがあります。",
					"",
					"[^1]: 判断に迷う内容は、止める前に管理者へ問い合わせます。",
				].join("\n"),
				[
					"You may not store unlawful content or content that infringes the rights of others[^1].",
					"If we find such content, we may suspend the note without notice.",
					"",
					"[^1]: Where the call is not clear-cut, we ask your administrator before suspending anything.",
				].join("\n"),
			),
			s(
				"止まったときの扱い",
				"If the Service Goes Down",
				"障害でサービスが止まった場合、止まっていた日数分を翌月の料金から差し引きます。それ以上の補償はありません。",
				"If a failure takes the service down, we deduct the affected days from the following month's fee. No further compensation is provided.",
			),
			s(
				"取り決めの変更",
				"Changes to These Terms",
				"変更する場合は、30日前に画面の上部でお知らせします。変更後も使い続けた場合は、同意したものとみなします。",
				"When we change these terms, we announce it at the top of the screen thirty days in advance. Continuing to use the service afterward counts as agreement.",
			),
		],
	},
	{
		path: "policy/privacy.md",
		kind: "aligned",
		crlf: true,
		weight: 51,
		title: { ja: "個人情報の扱い", en: "Handling of Personal Data" },
		description: { ja: "集める情報と、その使い道。", en: "What we collect and what we use it for." },
		sections: [
			s(
				"個人情報の扱い",
				"Handling of Personal Data",
				"サービスを動かすために必要な範囲でだけ、情報をいただきます。広告のために使うことはありません。",
				"We collect information only to the extent needed to run the service. We never use it for advertising.",
			),
			s(
				"集める情報",
				"What We Collect",
				[
					"名前とメールアドレス、それに接続した時刻と端末の種類を記録します。",
					"ノートの中身は集計の対象にしません。",
					"",
					"---",
					"",
					"記録の中身について尋ねたいときは、[相談の窓口][contact]までご連絡ください。",
					"",
					"[contact]: mailto:privacy@example.com",
				].join("\n"),
				[
					"We record your name and email address, along with when you connect and what kind of device you use.",
					"The contents of your notes are never included in our statistics.",
					"",
					"---",
					"",
					"To ask what exactly is recorded, write to our [privacy desk][contact].",
					"",
					"[contact]: mailto:privacy@example.com",
				].join("\n"),
			),
			s(
				"消してほしいとき",
				"Requesting Deletion",
				"設定画面から申し出れば、30日以内にすべて消します。消したあとは元へ戻せません。",
				"Request it from the settings screen and we erase everything within thirty days. Once erased, it cannot be restored.",
			),
		],
	},
	{
		path: "notes/release-notes.md",
		kind: "aligned",
		weight: 60,
		quote: "none",
		fm: ["date: 2025-03-04", "draft: false"],
		title: { ja: "更新の記録", en: "Release Notes" },
		description: { ja: "各版で変わったところ。", en: "What changed in each release." },
		sections: [
			s(
				"更新の記録",
				"Release Notes",
				"新しいものから順に並べています。細かな修正は載せていません。",
				"Entries are listed newest first. Minor fixes are not included.",
			),
			s(
				"3.2",
				"3.2",
				[
					"- 保存した検索を左側の一覧へ並べられるようにしました",
					"- 取り込みで HTML を扱えるようにしました",
					"- 大きなノートを開くときの待ち時間を半分にしました",
				].join("\n"),
				[
					"- Saved searches can now be listed in the sidebar",
					"- The importer now handles HTML",
					"- Opening a large note takes half as long as before",
				].join("\n"),
			),
			s(
				"3.1",
				"3.1",
				["- 拡張の一覧をチーム単位に変えました", "- ごみ箱に残る期間を14日から30日へ延ばしました"].join("\n"),
				["- The extension list is now managed per team", "- Items stay in the trash for 30 days instead of 14"].join(
					"\n",
				),
			),
		],
	},
	{
		path: "guide/offline.md",
		kind: "sourceOnly",
		weight: 26,
		title: { ja: "つながらない場所で使う", en: null },
		description: { ja: "通信のない場所での振る舞い。", en: null },
		sections: [
			s(
				"つながらない場所で使う",
				null,
				"移動中や社外など、通信のない場所でもノートは読み書きできます。書いたものは端末の中に残ります。",
				null,
			),
			s(
				"読める範囲",
				null,
				"直近で開いたノートは、そのまま読めます。まだ一度も開いていないノートは、つながるまで見られません。",
				null,
			),
		],
	},
	{
		path: "faq/accessibility.md",
		kind: "sourceOnly",
		weight: 43,
		title: { ja: "読み上げと配色", en: null },
		description: { ja: "見え方と読み上げの設定。", en: null },
		sections: [
			s(
				"読み上げと配色",
				null,
				"画面の読み上げと、色の見え方の設定について説明します。どちらも設定画面から変えられます。",
				null,
			),
			s(
				"読み上げ",
				null,
				"主要な画面は読み上げに対応しています。見出しの階層をたどって、目的の場所まで移動できます。",
				null,
			),
			// 見出しだけで本文が無い章。実サイトの原稿には「書きかけ」として残っていることがある。
			s("配色", null, "", null),
		],
	},
	{
		path: "legacy/old-guide.md",
		kind: "targetOnly",
		weight: 90,
		quote: "single",
		fm: ["date: 2024-09-30", "draft: false", "aliases: [/v2/]"],
		title: { ja: null, en: "Legacy Guide (Version 2)" },
		description: { ja: null, en: "Kept for teams still on version 2." },
		sections: [
			s(
				null,
				"Legacy Guide (Version 2)",
				null,
				"This page describes version 2, which reached end of life in March. It is kept for teams that have not migrated yet.",
			),
			s(
				null,
				"Differences from Version 3",
				null,
				"Version 2 has no tags and no saved searches. Notes are organized in folders only, and sharing is all-or-nothing.",
			),
		],
	},
];

/** Markdown 以外の管理下ファイル（.txt / .csv / .json） */
export const ASSETS = [
	{
		path: "data/notice.txt",
		crlf: true,
		ja: [
			"社内向けのお知らせ",
			"",
			"クモノートの定期点検を、毎月第2火曜日の午前2時から4時に行います。",
			"この時間帯はノートの閲覧と編集ができません。",
			"急ぎの作業は前日までに済ませてください。",
		].join("\n"),
		en: [
			"Internal Notice",
			"",
			"Scheduled maintenance for Kumo Note runs from 2:00 to 4:00 a.m. on the second Tuesday of every month.",
			"Notes cannot be read or edited during that window.",
			"Please finish any urgent work the day before.",
		].join("\n"),
	},
	{
		path: "data/contacts.csv",
		ja: [
			"部署,担当,連絡先",
			"サポート,問い合わせの窓口,support@example.com",
			"開発,不具合の報告,dev@example.com",
			"営業,契約と請求,sales@example.com",
		].join("\n"),
		en: [
			"Department,Role,Contact",
			"Support,General inquiries,support@example.com",
			"Development,Bug reports,dev@example.com",
			"Sales,Contracts and billing,sales@example.com",
		].join("\n"),
	},
	{
		path: "data/settings.json",
		ja: JSON.stringify(
			{
				name: "クモノートの既定の設定",
				description: "初期状態で読み込まれる設定の見本",
				items: [
					{ label: "自動保存", hint: "数秒ごとに保存する" },
					{ label: "夜間の配色", hint: "暗い色へ切り替える" },
				],
			},
			null,
			2,
		),
		en: JSON.stringify(
			{
				name: "Kumo Note default settings",
				description: "A sample of the settings loaded in the initial state",
				items: [
					{ label: "Autosave", hint: "Save every few seconds" },
					{ label: "Night colors", hint: "Switch to a dark palette" },
				],
			},
			null,
			2,
		),
	},
];

/**
 * 足せる対象言語（3言語目以降）。
 *
 * 何のためにあるか: 実サイトで言語を増やす途中は、**言語ごとに揃い方が違う**。
 * 「英語は人が訳し終えている、韓国語はまだ数ページだけ」という形が普通で、
 * mdait はそこへ取り込みをかけられなければならない（ADR-260825-01 が
 * 「設定した対象言語は初回から全部が対象」と決めているので、1コマンドで両方が走る）。
 *
 * ここに書いたページだけ訳文があり、書いていないページは訳文が無い（＝これから訳す）。
 * 章の作り分け（欠落・入れ替え・訳文だけの章）は英語の側で足りているので、
 * ここは全部そろっている形にしてある — 測りたいのは**2本目の対の振る舞い**だから。
 */
export const EXTRA_LANGS = [
	{
		code: "ko",
		name: "한국어",
		pages: {
			"_index.md": {
				title: "쿠모노트 문서",
				description: "팀에서 노트를 공유하기 위한 서비스 안내서.",
				fm: [
					"date: 2025-03-04",
					"draft: false",
					"keywords: [노트, 공유, 팀]",
					"summary: |",
					"  팀에서 노트를 공유하기 위한 서비스입니다.",
					"  이 안내서는 설치부터 일상적인 사용까지를 다룹니다.",
				],
				sections: [
					{
						h: "쿠모노트란",
						b: "쿠모노트는 팀이 작성한 노트를 한곳에 모아 공유하는 서비스입니다. 작성한 내용은 곧바로 모두에게 전달되며, 나중에 찾아볼 수 있습니다.",
					},
					{
						h: "할 수 있는 일",
						b: "노트 작성과 편집, 태그를 이용한 정리, 전문 검색, 팀 내 공유가 가능합니다. 유료 요금제에서는 변경 이력과 외부 서비스 연동이 추가됩니다.",
					},
					{
						h: "이 안내서를 읽는 법",
						b: "처음 사용하신다면 「설치하기」부터 순서대로 읽어 주세요. 이미 사용 중이시라면 필요한 장만 골라 읽으셔도 됩니다.",
					},
				],
			},
			"start/install.md": {
				title: "설치하기",
				description: "쿠모노트를 사용 환경에 설치하는 절차.",
				sections: [
					{
						h: "설치하기",
						b: "사용하시는 환경에 쿠모노트를 설치하고 팀의 노트를 읽을 수 있게 되기까지를 설명합니다. 10분 정도 걸립니다.",
					},
					{
						h: "동작 환경",
						b: "Windows 11, macOS 14 이상, Ubuntu 22.04 이상에서 동작합니다. 메모리는 4GB 이상, 여유 공간은 500MB 이상이 필요합니다.",
					},
					{
						h: "내려받기",
						b: "공식 사이트의 내려받기 페이지에서 사용 환경에 맞는 파일을 선택해 받으세요. 사내에서 배포하는 경우에는 관리자가 준 버전을 사용합니다.",
					},
					{
						h: "설치를 마친 뒤",
						b: "실행하면 먼저 로그인 화면이 나타납니다. 초대 메일에 적힌 암호를 입력하면 팀의 노트를 읽을 수 있습니다.",
					},
				],
			},
			"guide/tags.md": {
				title: "태그로 정리하기",
				description: "태그를 붙이는 방법과 좁혀 보는 방법.",
				sections: [
					{
						h: "태그로 정리하기",
						b: "노트가 늘어나면 폴더보다 태그로 정리하는 편이 찾기 쉽습니다. 노트 하나에 몇 개든 붙일 수 있습니다.",
					},
					{
						h: "태그 붙이기",
						b: [
							"본문 아무 곳에나 # 뒤에 단어를 적으면 그대로 태그가 됩니다. 붙이는 방법은 세 가지입니다.",
							"",
							"- 본문에 직접 적기",
							"  - # 뒤에 단어를 적는다",
							'  - 공백을 넣으려면 `#"회의 기록"`처럼 묶는다',
							"- 제목 아래 칸에서 고르기",
							"  - 자주 쓰는 것이 위에 온다",
							"  - 새 단어를 입력하면 그 자리에서 만들어진다",
							"- 목록 화면에서 한꺼번에 붙이기",
						].join("\n"),
					},
					{
						h: "태그 순서 바꾸기",
						b: "왼쪽 목록에서는 자주 쓰는 태그를 위로 끌어올릴 수 있습니다. 순서는 팀 전체가 아니라 각자의 화면에만 적용됩니다.",
					},
					{
						h: "태그로 좁혀 보기",
						b: "태그를 누르면 그 태그가 붙은 노트만 나열됩니다. 두 개 이상을 누르면 모두에 해당하는 노트로 좁혀집니다.",
					},
				],
			},
			"reference/shortcuts.md": {
				title: "키보드 단축키",
				description: "자주 쓰는 조작의 단축키 목록.",
				sections: [
					{
						h: "키보드 단축키",
						b: "마우스로 손을 옮기지 않아도 되도록, 자주 쓰는 조작에는 단축키가 있습니다. 설정 화면에서 바꿀 수 있습니다.",
					},
					{
						h: "목록",
						b: [
							"| 조작 | Windows / Linux | macOS |",
							"| --- | --- | --- |",
							"| 새 노트 | Ctrl + N | Cmd + N |",
							"| 찾기 | Ctrl + K | Cmd + K |",
							"| 공유하기 | Ctrl + Shift + S | Cmd + Shift + S |",
							"| 휴지통으로 보내기 | Ctrl + Delete | Cmd + Delete |",
						].join("\n"),
					},
				],
			},
			"faq/security.md": {
				title: "보안",
				description: "맡겨 주신 내용을 다루는 방식.",
				sections: [
					{
						h: "보안",
						b: "맡겨 주신 노트를 어떻게 지키는지 설명합니다. 자세한 내용은 이용약관에 있습니다.",
					},
					{
						h: "전송 중과 보관 중",
						b: [
							"모든 통신은 암호화되어 있습니다(TLS 1.3, AES-256-GCM).",
							"보관할 때도 암호화하며, 키는 노트 내용과 **다른 곳**에 둡니다.",
							"",
							"- 🔒 전송 중 … TLS 1.3",
							"- 🗄️ 보관 중 … AES-256-GCM",
							"- 🔑 키 보관 … 별도 시스템(키는 90일마다 교체)",
							"",
							"암호는 12자 이상이며, 영문자·숫자·기호 중 두 종류 이상을 섞어야 합니다.",
						].join("\n"),
					},
					{
						h: "누가 볼 수 있는가",
						b: "운영자가 노트의 내용을 읽는 일은 없습니다. 장애 조사로 필요한 경우에는 사전에 팀 관리자에게 알립니다.",
					},
				],
			},
		},
	},
];
