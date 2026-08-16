/**
 * @file rename-plan.ts
 * @description
 *   ファイルの移動（リネーム・フォルダ移動）に、対になる相手と `unit-state` の行を
 *   追随させるための計画を立てる。
 *
 *   **原文が正、訳文が従**である。原文が動いたら訳文を連れて動かし、訳文だけが動いたときは
 *   原文に手を出さず行の `path` だけ付け替える。訳文の位置は原文から導出できるが、逆は
 *   一意に決まらない（1つの原文が複数言語の訳文を持つ）ためで、従属の向きを逆にすると
 *   1ファイルの移動が他言語の訳文を巻き込んで動かすことになる。
 *
 *   ## 2つの計画に分かれている理由
 *
 *   ファイルを動かせるのは移動の**前**だけで（`onWillRenameFiles` の `waitUntil` に返した
 *   編集だけがユーザーの取り消し単位に入る）、`unit-state` の行を付け替えてよいのは移動が
 *   **成功したあと**である。前後で世界の見え方が違うので、判断の材料も違う。
 *
 *   - {@link planRenameFollow} … 移動の前。「訳文がそこに在り、行き先が空いているか」を見る
 *   - {@link planEntryMoves} … 移動の後。「訳文がもう新しい場所に居るか」を見る
 *
 *   後者を、前者が立てた計画の控えではなく**その場の実測**にしてあるのは、計画どおりに
 *   動いたとは限らないからである。とくに Ctrl+Z の取り消しは、こちらが足した訳文の移動も
 *   まとめて巻き戻すが、そのときエディタが何を「移動した」と報せてくるかは保証されていない。
 *   実測なら、報せに何が並んでいても、実際に動いたものにだけ行が付いていく。
 *
 *   ここは計画だけを作る純粋な関数で、ファイルを動かしも行を書き換えもしない。
 *   間違えやすい部分（ペアの導出・重複の排除・行き先の衝突・連鎖）だけを
 *   VS Code 抜きで確かめられるようにするためである。
 *
 * @module core/unit-state/rename-plan
 */

/** 1件の移動。ファイルでもディレクトリでもよく、パスの表記は probe の契約に従う */
export interface PathRename {
	oldPath: string;
	newPath: string;
}

/** 連れて動かせなかった理由 */
export type RenameFollowBlockReason = "destination-exists";

/** 連れて動かせなかった移動と、その理由 */
export interface BlockedRename {
	rename: PathRename;
	reason: RenameFollowBlockReason;
}

/** 計画を立てるために外の世界へ問い合わせること */
export interface RenameFollowProbe {
	/**
	 * 原文の移動から、対応する訳文の移動をペアの数だけ作る。
	 * 原文ディレクトリの配下でない、または移動先から訳文パスを導出できない場合は空を返す。
	 *
	 * ペアの計算（どのディレクトリ同士が対応しているか）はここに閉じ込める。
	 * 計画側はその結果を選り分けるだけで、対応関係の定義を持たない。
	 */
	deriveTargetRenames(rename: PathRename): PathRename[];
	/** そのパスに実体があるか（ファイル・ディレクトリを問わない） */
	exists(path: string): boolean;
	/**
	 * そのパス（またはその配下）に `unit-state` の行が既にあるか。
	 *
	 * 「mdait が以前から知っている場所か」を問うために要る。移動が済んだあとの世界では
	 * 「旧パスに無い・新パスに在る」だけでは**動いてきたのか、前から在ったのか**を
	 * 区別できない（{@link planEntryMoves} を見よ）。ディレクトリの移動も扱うので
     * 配下まで含めて答えること。
	 */
	hasEntriesAt(path: string): boolean;
	/** 同じ場所を指すパスを同じ文字列にする（重複の排除に使う） */
	sameKey(path: string): string;
}

/** 移動の前に立てる計画 */
export interface RenameFollowPlan {
	/** 原文に連れて動かす訳文。ユーザーの移動と同じ取り消し単位で行う */
	companions: PathRename[];
	/** 連れて行けなかったもの。ユーザーには出さずログに残す（孤立として画面には出る） */
	blocked: BlockedRename[];
}

/**
 * 追随の連鎖を打ち切る上限。
 *
 * `ja→en, en→fr` のように訳文がさらに別のペアの原文を兼ねる構成（ピボット）では、
 * 連れて動かした訳文からさらに訳文が導かれる。同じ移動元を二度積まないので通常は自然に
 * 止まるが、設定が循環していると止まらなくなりうる。**エディタの操作をここで止めるわけには
 * いかない**ので、上限で必ず抜ける。
 */
const MAX_FOLLOW_STEPS = 10_000;

/** 導かれた移動を採るかどうかの判定 */
type Verdict = "take" | "skip" | "blocked";

/**
 * ユーザーの移動を起点に、対応する訳文の移動を連鎖させて辿る。
 *
 * 連鎖するのは、連れて動かした訳文がさらに別のペアの原文を兼ねていることがあるためである
 * （ピボット構成）。ここで積み直さないと、その先の訳文だけが取り残されて新しい孤立を作る。
 *
 * @param renames ユーザーが行おうとしている（または行った）移動
 * @param probe ペアの導出と実在確認
 * @param decide 導かれた移動1件ごとの判定
 */
function walkFollow(
	renames: readonly PathRename[],
	probe: RenameFollowProbe,
	decide: (candidate: PathRename, claimedDestinations: ReadonlySet<string>) => Verdict,
): { taken: PathRename[]; blocked: BlockedRename[] } {
	const taken: PathRename[] = [];
	const blocked: BlockedRename[] = [];

	// 「既に誰かが動かす」移動元と行き先。ユーザーが原文と訳文を両方まとめて選んで
	// 動かしたとき（複数選択）に、同じ訳文を二重に扱わないために要る
	const claimedSources = new Set(renames.map((r) => probe.sameKey(r.oldPath)));
	const claimedDestinations = new Set(renames.map((r) => probe.sameKey(r.newPath)));

	const queue: PathRename[] = [...renames];
	let steps = 0;
	while (queue.length > 0 && steps++ < MAX_FOLLOW_STEPS) {
		const rename = queue.shift() as PathRename;

		for (const candidate of probe.deriveTargetRenames(rename)) {
			const from = probe.sameKey(candidate.oldPath);
			const to = probe.sameKey(candidate.newPath);
			if (from === to || claimedSources.has(from)) {
				continue; // 動かす必要が無い、または既に扱っている
			}
			const verdict = decide(candidate, claimedDestinations);
			if (verdict === "blocked") {
				blocked.push({ rename: candidate, reason: "destination-exists" });
				continue;
			}
			if (verdict === "skip") {
				continue;
			}
			claimedSources.add(from);
			claimedDestinations.add(to);
			taken.push(candidate);
			queue.push(candidate);
		}
	}

	return { taken, blocked };
}

/**
 * **移動の前に**、原文に連れて動かす訳文を決める。
 *
 * @param renames ユーザーが行おうとしている移動
 * @param probe ペアの導出と実在確認
 */
export function planRenameFollow(
	renames: readonly PathRename[],
	probe: RenameFollowProbe,
): RenameFollowPlan {
	const { taken, blocked } = walkFollow(renames, probe, (candidate, claimedDestinations) => {
		if (!probe.exists(candidate.oldPath)) {
			return "skip"; // 訳文がまだ無い。sync が原文から作る
		}
		// 行き先が塞がっているときは動かさない。上書きすると別の訳文が消え、
		// ごみ箱も経由しない（＝取り返しがつかない）。連れて行かなかった訳文は
		// 原文を失うので、段階1の孤立としてツリーに出る
		if (claimedDestinations.has(probe.sameKey(candidate.newPath)) || probe.exists(candidate.newPath)) {
			return "blocked";
		}
		return "take";
	});
	return { companions: taken, blocked };
}

/**
 * **移動が済んだあとに**、`unit-state` の行をどう付け替えるかを決める。
 *
 * ユーザーが動かしたぶんは必ず含める。素性（原文か訳文か・管理下か）で間引かないのは、
 * 対象外のパスには行が無いので書き換え側が何もしないだけで済むからである。ここで判定を
 * 挟むと、判定の取りこぼしがそのまま状態の取りこぼしになる。
 *
 * 訳文のぶんは「**もう新しい場所に居るか**」で決める。連れて動かした結果そこに在るなら
 * 行も連れて行き、旧パスに残っているなら行も残す。計画の控えではなく実測にしてあるので、
 * 取り消しで巻き戻されたときも、エディタが何を報せてきたかに関わらず実態に合う。
 *
 * @param renames 実際に行われた移動（エディタが報せてきたもの）
 * @param probe ペアの導出と実在確認
 */
export function planEntryMoves(renames: readonly PathRename[], probe: RenameFollowProbe): PathRename[] {
	const { taken } = walkFollow(renames, probe, (candidate) => {
		// 旧パスに残っているなら、その訳文は動いていない（行き先が塞がっていた等）
		if (probe.exists(candidate.oldPath)) {
			return "skip";
		}
		if (!probe.exists(candidate.newPath)) {
			return "skip";
		}
		// **行き先を mdait が既に知っているなら、そこは「動いてきた先」ではない。**
		//
		// 「旧パスに無い・新パスに在る」は、訳文が動いた場合だけでなく
		// 「旧パスの訳文は前に消されていて、新パスには無関係な訳文が前から在った」
		// でも成り立つ。実在だけを見て動かすと、`UnitStateStore.movePath` が行き先の行を
		// 先に全消しするので、**別の文書の from と need が消える**。from は本文から
		// 計算し直せない唯一の情報なので、消えた瞬間にその訳文は need:translate へ落ちる。
		//
		// 連れて動かした訳文なら、行はまだ旧パスに付いている（付け替えるのがこれからの
		// 仕事である）ので、行き先に行は無い。だからこの条件で本物だけが残る。
		//
		// 前段（`planRenameFollow`）は同じ状況を「訳文がまだ無い」として既に見送っている。
		// 前後で判断が食い違っていたのが元の欠陥だった。
		if (probe.hasEntriesAt(candidate.newPath)) {
			return "skip";
		}
		return "take";
	});
	return [...renames, ...taken];
}
