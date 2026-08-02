import * as assert from "node:assert";
import {
	OperationCancelledError,
	isOperationCancelled,
	rethrowIfCancelled,
} from "../../../../infra/errors/operation-cancelled";

suite("OperationCancelledError（中断の単一表現）", () => {
	test("専用の型は中断と判定される", () => {
		assert.strictEqual(isOperationCancelled(new OperationCancelledError()), true);
	});

	test("VS Code の CancellationError（name が Canceled）も中断と判定される", () => {
		const error = new Error("Canceled");
		error.name = "Canceled";
		assert.strictEqual(isOperationCancelled(error), true);
	});

	test("ふつうの失敗は中断と判定されない", () => {
		assert.strictEqual(isOperationCancelled(new Error("AI unavailable")), false);
	});

	test("メッセージに cancel と書いてあるだけの失敗を中断と誤判定しない", () => {
		// 原稿や API のメッセージにたまたま含まれる語で誤判定しないこと。
		// 以前は文字列一致で判定しており、プロバイダが文言を変えるだけで壊れていた
		assert.strictEqual(
			isOperationCancelled(new Error("The subscription was cancelled by the provider")),
			false,
		);
	});

	test("Error でない値は中断と判定されない", () => {
		assert.strictEqual(isOperationCancelled("cancelled"), false);
		assert.strictEqual(isOperationCancelled(undefined), false);
	});

	suite("rethrowIfCancelled", () => {
		test("中断ならそのまま投げ直す（プロバイダ名でラップさせない）", () => {
			assert.throws(
				() => rethrowIfCancelled(new OperationCancelledError("Request aborted")),
				(error: unknown) => isOperationCancelled(error),
			);
		});

		test("VS Code の CancellationError は専用の型に寄せて投げ直す", () => {
			const error = new Error("Canceled");
			error.name = "Canceled";
			assert.throws(
				() => rethrowIfCancelled(error),
				(thrown: unknown) => thrown instanceof OperationCancelledError,
			);
		});

		test("中断でなければ何もしない", () => {
			assert.doesNotThrow(() => rethrowIfCancelled(new Error("boom")));
		});
	});
});
