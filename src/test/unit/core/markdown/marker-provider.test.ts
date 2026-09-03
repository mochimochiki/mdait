// MarkerProvider（マーカー出し入れ口の Strategy）のテスト
// フェーズ0では embedded（既定）が no-op で、provider 注入が振る舞いを変えないことを検証する

import { strict as assert } from "node:assert";
import { EmbeddedMarkerProvider, embeddedMarkerProvider } from "../../../../core/markdown/marker-provider";
import { markdownParser } from "../../../../core/markdown/parser";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

const sampleMarkdown = [
	"<!-- mdait a1b2c3 -->",
	"# 見出し1",
	"",
	"本文1。",
	"",
	"<!-- mdait d4e5f6 -->",
	"## 見出し2",
	"",
	"本文2。",
	"",
].join("\n");

suite("MarkerProvider", () => {
	suite("EmbeddedMarkerProvider", () => {
		test("mode は embedded で、markersFormBoundaries は true である", () => {
			const provider = new EmbeddedMarkerProvider();
			assert.strictEqual(provider.mode, "embedded");
			assert.strictEqual(provider.markersFormBoundaries, true);
		});

		test("attachMarkers / detachMarkers は no-op でユニットを変更しない", () => {
			const config = makeConfig(2);
			const parsed = markdownParser.parse(sampleMarkdown, config);
			const before = parsed.units.map((u) => u.toString());

			embeddedMarkerProvider.attachMarkers(parsed.units);
			embeddedMarkerProvider.detachMarkers(parsed.units);

			const after = parsed.units.map((u) => u.toString());
			assert.deepStrictEqual(after, before, "no-op のはずがユニットが変化した");
		});
	});

	suite("parse / stringify への provider 注入", () => {
		test("provider 省略時と embeddedMarkerProvider 明示時で parse 結果が一致する", () => {
			const config = makeConfig(2);
			const omitted = markdownParser.parse(sampleMarkdown, config);
			const explicit = markdownParser.parse(sampleMarkdown, config, embeddedMarkerProvider);

			assert.strictEqual(explicit.units.length, omitted.units.length, "ユニット数が一致しない");
			assert.deepStrictEqual(
				explicit.units.map((u) => u.toString()),
				omitted.units.map((u) => u.toString()),
				"ユニット内容が一致しない",
			);
		});

		test("provider 省略時と embeddedMarkerProvider 明示時で stringify 結果が一致する", () => {
			const config = makeConfig(2);
			const parsed = markdownParser.parse(sampleMarkdown, config);

			const omitted = markdownParser.stringify(parsed);
			const explicit = markdownParser.stringify(parsed, embeddedMarkerProvider);

			assert.strictEqual(explicit, omitted, "stringify 結果が一致しない");
		});

		test("embedded provider を介しても parse→stringify がラウンドトリップする", () => {
			const config = makeConfig(2);
			const parsed = markdownParser.parse(sampleMarkdown, config, embeddedMarkerProvider);
			const stringified = markdownParser.stringify(parsed, embeddedMarkerProvider);

			const reparsed = markdownParser.parse(stringified, config, embeddedMarkerProvider);
			const restringified = markdownParser.stringify(reparsed, embeddedMarkerProvider);

			assert.strictEqual(restringified, stringified, "ラウンドトリップが非冪等");
			assert.strictEqual(reparsed.units.length, parsed.units.length, "ユニット数が変化した");
		});
	});
});
