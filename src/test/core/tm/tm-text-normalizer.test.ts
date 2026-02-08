/**
 * @file tm-text-normalizer.test.ts
 * @description
 *   tm-text-normalizerモジュールのユニットテスト。
 *   stripMarkdownとisWorthyForTmの動作を検証する。
 */
import { strict as assert } from "node:assert";
import { isWorthyForTm, stripMarkdown } from "../../../core/tm/tm-text-normalizer";

suite("core/tm/tm-text-normalizer", () => {
	suite("stripMarkdown", () => {
		test("リンクを除去してテキストのみ抽出", () => {
			assert.equal(stripMarkdown("[text](url)"), "text");
			assert.equal(stripMarkdown("Visit [Google](https://google.com) now"), "Visit Google now");
		});

		test("画像を除去してalt部分のみ抽出", () => {
			assert.equal(stripMarkdown("![alt text](image.png)"), "alt text");
			assert.equal(stripMarkdown("See ![diagram](url) here"), "See diagram here");
		});

		test("太字を除去してテキストのみ抽出", () => {
			assert.equal(stripMarkdown("**bold**"), "bold");
			assert.equal(stripMarkdown("__bold__"), "bold");
			assert.equal(stripMarkdown("This is **bold** text"), "This is bold text");
		});

		test("強調を除去してテキストのみ抽出", () => {
			assert.equal(stripMarkdown("*italic*"), "italic");
			assert.equal(stripMarkdown("_italic_"), "italic");
			assert.equal(stripMarkdown("This is *emphasized* text"), "This is emphasized text");
		});

		test("削除線を除去してテキストのみ抽出", () => {
			assert.equal(stripMarkdown("~~strikethrough~~"), "strikethrough");
			assert.equal(stripMarkdown("This is ~~deleted~~ text"), "This is deleted text");
		});

		test("インラインコードを完全除外", () => {
			assert.equal(stripMarkdown("`code`"), "");
			assert.equal(stripMarkdown("This is `code` here"), "This is here");
			assert.equal(stripMarkdown("Use `npm install` command"), "Use command");
		});

		test("コードブロックを完全除外", () => {
			assert.equal(stripMarkdown("```\ncode block\n```"), "");
			assert.equal(stripMarkdown("Before\n```\ncode block\n```\nAfter"), "Before After");
			assert.equal(stripMarkdown("Text ```javascript\nconst x = 1;\n``` more"), "Text more");
		});

		test("HTMLタグを除去してcontentのみ抽出", () => {
			assert.equal(stripMarkdown("<tag>content</tag>"), "content");
			assert.equal(stripMarkdown("This is <strong>bold</strong> text"), "This is bold text");
			assert.equal(stripMarkdown("<br>"), "");
		});

		test("複数要素が混在する複雑なケース", () => {
			const input = "Visit **[Google](https://google.com)** for `code` examples";
			const expected = "Visit Google for examples";
			assert.equal(stripMarkdown(input), expected);
		});

		test("ネスト構造のケース", () => {
			const input = "![image **with bold**](url)";
			const expected = "image with bold";
			assert.equal(stripMarkdown(input), expected);
		});

		test("余分な空白の正規化", () => {
			assert.equal(stripMarkdown("  multiple   spaces  "), "multiple spaces");
			assert.equal(stripMarkdown("before\n\nafter"), "before after");
		});

		test("空文字列の場合", () => {
			assert.equal(stripMarkdown(""), "");
			assert.equal(stripMarkdown("   "), "");
		});

		test("Markdown要素が含まれない通常テキスト", () => {
			assert.equal(stripMarkdown("Hello world"), "Hello world");
			assert.equal(stripMarkdown("これは日本語です"), "これは日本語です");
		});

		suite("表の処理", () => {
			test("基本的な表から各セルの内容のみ抽出", () => {
				const input = "| Header1 | Header2 |\n|---------|----------|\n| Cell1   | Cell2   |";
				const expected = "Header1 Header2 Cell1 Cell2";
				assert.equal(stripMarkdown(input), expected);
			});

			test("複数行の表", () => {
				const input = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
				const expected = "Name Age Alice 30 Bob 25";
				assert.equal(stripMarkdown(input), expected);
			});

			test("数値のみの表", () => {
				const input = "| 0.12 | 333 |\n|------|-----|\n| 456  | 789 |";
				const expected = "0.12 333 456 789";
				assert.equal(stripMarkdown(input), expected);
			});

			test("セル内にMarkdown記法を含む表", () => {
				const input = "| **Bold** | *Italic* |\n|----------|----------|\n| [Link](url) | `code` |";
				const expected = "Bold Italic Link";
				assert.equal(stripMarkdown(input), expected);
			});

			test("表のセル内のインラインコードは完全除外される", () => {
				const input = "| Text | `code` |\n|------|--------|\n| Hello | `world` |";
				const expected = "Text Hello";
				assert.equal(stripMarkdown(input), expected);
			});

			test("空セルを含む表", () => {
				const input = "| A |  | C |\n|---|---|---|\n| 1 |  | 3 |";
				const expected = "A C 1 3";
				assert.equal(stripMarkdown(input), expected);
			});

			test("単一セルの表", () => {
				const input = "| Single |\n|--------|\n| Cell |";
				const expected = "Single Cell";
				assert.equal(stripMarkdown(input), expected);
			});

			test("表の前後にテキストがある場合", () => {
				const input = "Before table\n\n| Col1 | Col2 |\n|------|------|\n| A | B |\n\nAfter table";
				const expected = "Before table Col1 Col2 A B After table";
				assert.equal(stripMarkdown(input), expected);
			});

			test("区切り線のみが除去される", () => {
				const input = "| H1 | H2 |\n|----|----|";
				const expected = "H1 H2";
				assert.equal(stripMarkdown(input), expected);
			});
		});
	});

	suite("isWorthyForTm", () => {
		suite("日本語の最小長チェック（8文字）", () => {
			test("8文字未満は除外", () => {
				assert.equal(isWorthyForTm("短い", "ja"), false); // 2文字
				assert.equal(isWorthyForTm("少し長い", "ja"), false); // 4文字
				assert.equal(isWorthyForTm("もう少し", "ja"), false); // 4文字
				assert.equal(isWorthyForTm("これは七文字", "ja"), false); // 7文字
			});

			test("8文字以上は通過", () => {
				assert.equal(isWorthyForTm("これは八文字です", "ja"), true); // 8文字
				assert.equal(isWorthyForTm("これは良い文章です", "ja"), true); // 9文字
			});
		});

		suite("英語の最小長チェック（12文字）", () => {
			test("12文字未満は除外", () => {
				assert.equal(isWorthyForTm("short", "en"), false); // 5文字
				assert.equal(isWorthyForTm("Hello world", "en"), false); // 11文字
			});

			test("12文字以上でも単語数不足なら除外", () => {
				assert.equal(isWorthyForTm("Hello world!", "en"), false); // 12文字だが2単語
			});

			test("12文字以上かつ3単語以上は通過", () => {
				assert.equal(isWorthyForTm("This is a good sentence", "en"), true); // 23文字、5単語
				assert.equal(isWorthyForTm("Hello world there", "en"), true); // 17文字、3単語
			});
		});

		suite("数値のみは除外", () => {
			test("整数", () => {
				assert.equal(isWorthyForTm("123", "en"), false);
				assert.equal(isWorthyForTm("1234567890", "en"), false);
			});

			test("小数", () => {
				assert.equal(isWorthyForTm("3.14", "en"), false);
				assert.equal(isWorthyForTm("123.456", "en"), false);
			});

			test("カンマ区切り", () => {
				assert.equal(isWorthyForTm("1,000", "en"), false);
				assert.equal(isWorthyForTm("1,234,567", "en"), false);
			});

			test("負の数値", () => {
				assert.equal(isWorthyForTm("-123", "en"), false);
				assert.equal(isWorthyForTm("-3.14", "en"), false);
			});

			test("数値を含むが文章の場合は通過", () => {
				assert.equal(isWorthyForTm("There are 123 items here", "en"), true);
				assert.equal(isWorthyForTm("Price is 3.14 dollars", "en"), true);
			});
		});

		suite("URL/パスのみは除外", () => {
			test("URL", () => {
				assert.equal(isWorthyForTm("https://example.com", "en"), false);
				assert.equal(isWorthyForTm("http://localhost:3000", "en"), false);
			});

			test("相対パス", () => {
				assert.equal(isWorthyForTm("./path/to/file", "en"), false);
				assert.equal(isWorthyForTm("../parent/file.txt", "en"), false);
			});

			test("絶対パス", () => {
				assert.equal(isWorthyForTm("/usr/local/bin", "en"), false);
				assert.equal(isWorthyForTm("/path/to/file", "en"), false);
			});

			test("URL/パスを含むが文章の場合は通過", () => {
				assert.equal(isWorthyForTm("Visit https://example.com for more", "en"), true);
				assert.equal(isWorthyForTm("The file ./path/to/file exists", "en"), true);
			});
		});

		suite("英語の単語数チェック（2単語以下は除外）", () => {
			test("1単語は除外", () => {
				assert.equal(isWorthyForTm("Hello", "en"), false);
				assert.equal(isWorthyForTm("Documentation", "en"), false);
			});

			test("2単語は除外", () => {
				assert.equal(isWorthyForTm("Hello world", "en"), false);
				assert.equal(isWorthyForTm("Thank you", "en"), false);
			});

			test("3単語以上は通過", () => {
				assert.equal(isWorthyForTm("Hello world there", "en"), true);
				assert.equal(isWorthyForTm("This is good", "en"), true);
				assert.equal(isWorthyForTm("Thank you very much", "en"), true);
			});
		});

		suite("日本語の単語数チェック（チェックなし）", () => {
			test("日本語は単語数チェックされない", () => {
				// 8文字以上であれば何単語でも通過
				assert.equal(isWorthyForTm("これは良い文です", "ja"), true); // 8文字
				assert.equal(isWorthyForTm("こんにちは世界です", "ja"), true); // 9文字
			});
		});

		suite("正常な文は通過", () => {
			test("英語の正常な文", () => {
				assert.equal(isWorthyForTm("This is a good sentence for translation memory.", "en"), true);
				assert.equal(isWorthyForTm("Please configure your settings properly.", "en"), true);
			});

			test("日本語の正常な文", () => {
				assert.equal(isWorthyForTm("これは翻訳メモリに登録する価値のある文章です。", "ja"), true);
				assert.equal(isWorthyForTm("設定を適切に構成してください。", "ja"), true);
			});
		});

		suite("エッジケース", () => {
			test("空文字列は除外", () => {
				assert.equal(isWorthyForTm("", "en"), false);
				assert.equal(isWorthyForTm("   ", "en"), false);
			});

			test("スペースのみは除外", () => {
				assert.equal(isWorthyForTm("     ", "en"), false);
			});

			test("改行のみは除外", () => {
				assert.equal(isWorthyForTm("\n\n\n", "en"), false);
			});
		});
	});
});
