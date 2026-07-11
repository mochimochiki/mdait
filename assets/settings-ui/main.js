// @ts-check
// mdait 設定エディタ webview クライアント。
// 表示とユーザー操作のみを担い、検証・書き込みはすべて拡張側（settings-panel.ts）が行う。
(function () {
	// @ts-ignore acquireVsCodeApi は webview ランタイムが提供する
	const vscode = acquireVsCodeApi();

	/** @type {Array<any>} */
	let categories = [];
	/** @type {Record<string, string>} */
	let strings = {};
	/** @type {Record<string, {value: any, present: boolean}>} */
	let values = {};
	/** 設定ID → 再描画コールバック */
	const refreshers = new Map();
	/** 設定ID → 行要素（検索用） */
	const rowsById = new Map();

	window.addEventListener("message", (event) => {
		const message = event.data;
		switch (message.type) {
			case "init":
				categories = message.categories;
				strings = message.strings;
				values = message.values;
				render();
				break;
			case "values":
				values = message.values;
				refreshAll();
				break;
			case "error":
				showToast(message.message);
				break;
		}
	});
	vscode.postMessage({ type: "ready" });

	// ---------- ヘルパー ----------

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	function effectiveValue(setting) {
		const info = values[setting.id];
		if (info && info.present) {
			return info.value;
		}
		return setting.default;
	}

	function isModified(setting) {
		const info = values[setting.id];
		return !!(info && info.present);
	}

	/** stringArray 値を配列に正規化（ignoredPatterns は文字列単体もあり得る） */
	function toStringArray(value) {
		if (Array.isArray(value)) {
			return value.map(String);
		}
		if (typeof value === "string" && value.length > 0) {
			return [value];
		}
		return [];
	}

	function post(type, payload) {
		vscode.postMessage(Object.assign({ type: type }, payload));
	}

	let toastTimer;
	function showToast(message) {
		let toast = document.querySelector(".toast");
		if (!toast) {
			toast = el("div", "toast");
			document.body.appendChild(toast);
		}
		toast.textContent = message;
		toast.classList.add("visible");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toast.classList.remove("visible"), 4000);
	}

	// ---------- レンダリング ----------

	function render() {
		const app = document.getElementById("app");
		app.textContent = "";
		refreshers.clear();
		rowsById.clear();

		// ヘッダー: 検索 + mdait.json を開く
		const header = el("div", "header");
		const search = /** @type {HTMLInputElement} */ (el("input", "search-input"));
		search.type = "text";
		search.placeholder = strings.searchPlaceholder;
		search.addEventListener("input", () => applyFilter(search.value));
		const openJson = el("button", "open-json-button", strings.openJson);
		openJson.addEventListener("click", () => post("openJson", {}));
		header.appendChild(search);
		header.appendChild(openJson);
		app.appendChild(header);

		const body = el("div", "body");
		const nav = el("nav", "nav");
		const content = el("div", "content");
		body.appendChild(nav);
		body.appendChild(content);
		app.appendChild(body);

		const noResults = el("div", "no-results", strings.noResults);
		noResults.style.display = "none";
		content.appendChild(noResults);

		for (const category of categories) {
			const section = el("section", "category");
			section.id = "category-" + category.id;
			section.appendChild(el("h2", "category-title", category.label));
			if (category.description) {
				section.appendChild(el("p", "category-description", category.description));
			}
			for (const setting of category.settings) {
				const row = renderSetting(setting);
				rowsById.set(setting.id, { row: row, setting: setting, section: section });
				section.appendChild(row);
			}
			content.appendChild(section);

			const navItem = el("button", "nav-item", category.label);
			navItem.dataset.category = category.id;
			navItem.addEventListener("click", () => {
				section.scrollIntoView({ block: "start" });
			});
			nav.appendChild(navItem);
		}

		// スクロールに応じてナビの現在位置を強調
		content.addEventListener("scroll", () => updateActiveNav(content, nav));
		updateActiveNav(content, nav);
	}

	function updateActiveNav(content, nav) {
		const sections = content.querySelectorAll(".category");
		let activeId = null;
		for (const section of sections) {
			if (section.style.display === "none") {
				continue;
			}
			if (section.offsetTop - content.scrollTop <= 80) {
				activeId = section.id.replace("category-", "");
			}
		}
		for (const item of nav.querySelectorAll(".nav-item")) {
			item.classList.toggle("active", item.dataset.category === activeId);
		}
	}

	function applyFilter(query) {
		const q = query.trim().toLowerCase();
		let anyVisible = false;
		const visibleBySection = new Map();
		for (const entry of rowsById.values()) {
			const s = entry.setting;
			const haystack = (s.label + " " + s.id + " " + s.localizedDescription).toLowerCase();
			const visible = q.length === 0 || haystack.includes(q);
			entry.row.style.display = visible ? "" : "none";
			if (visible) {
				anyVisible = true;
				visibleBySection.set(entry.section, true);
			}
		}
		for (const section of document.querySelectorAll(".category")) {
			section.style.display = visibleBySection.has(section) || q.length === 0 ? "" : "none";
		}
		for (const item of document.querySelectorAll(".nav-item")) {
			const section = document.getElementById("category-" + item.dataset.category);
			item.style.display = section && section.style.display !== "none" ? "" : "none";
		}
		const noResults = document.querySelector(".no-results");
		noResults.style.display = anyVisible ? "none" : "";
	}

	function refreshAll() {
		for (const [id, refresh] of refreshers) {
			const entry = rowsById.get(id);
			// 入力中の行は上書きしない（自己書き込みのエコーでカーソルが飛ぶのを防ぐ）
			if (entry && entry.row.contains(document.activeElement)) {
				updateModifiedIndicator(entry.row, entry.setting);
				continue;
			}
			refresh();
		}
	}

	function updateModifiedIndicator(row, setting) {
		row.classList.toggle("modified", isModified(setting));
	}

	/** 設定 1 件分の行を構築する */
	function renderSetting(setting) {
		const row = el("div", "setting");
		row.dataset.id = setting.id;

		const header = el("div", "setting-header");
		header.appendChild(el("span", "setting-label", setting.label));
		header.appendChild(el("span", "setting-id", setting.id));
		if (setting.required) {
			header.appendChild(el("span", "badge", strings.requiredBadge));
		}
		const reset = el("button", "reset-button", "↺ " + strings.resetToDefault);
		reset.title = strings.resetToDefault;
		reset.addEventListener("click", () => post("reset", { id: setting.id }));
		header.appendChild(reset);
		row.appendChild(header);

		const description = el("p", "setting-description", setting.localizedDescription);
		if (setting.default !== undefined && setting.type !== "objectArray") {
			const hint = el(
				"span",
				"default-hint",
				strings.defaultLabel + ": " + JSON.stringify(setting.default),
			);
			description.appendChild(hint);
		}
		row.appendChild(description);

		const control = el("div", "control");
		row.appendChild(control);

		const renderControl = CONTROL_RENDERERS[setting.type] || renderUnsupported;
		const refreshControl = renderControl(control, setting);
		refreshers.set(setting.id, () => {
			refreshControl();
			updateModifiedIndicator(row, setting);
		});
		refreshControl();
		updateModifiedIndicator(row, setting);
		return row;
	}

	// ---------- 型別コントロール ----------
	// 各レンダラーは control 要素へ DOM を構築し、値を再反映する refresh 関数を返す

	function renderBoolean(control, setting) {
		const wrapper = el("div", "checkbox-row");
		const checkbox = /** @type {HTMLInputElement} */ (el("input"));
		checkbox.type = "checkbox";
		checkbox.addEventListener("change", () => {
			post("update", { id: setting.id, value: checkbox.checked });
		});
		wrapper.appendChild(checkbox);
		control.appendChild(wrapper);
		return () => {
			checkbox.checked = effectiveValue(setting) === true;
		};
	}

	function renderEnum(control, setting) {
		const select = /** @type {HTMLSelectElement} */ (el("select"));
		const hasDefault = setting.default !== undefined;
		if (!hasDefault) {
			// 既定値なし（orphanTargetPolicy 等）: 未設定を表す空選択肢を先頭に置く
			const empty = el("option", "", "");
			empty.value = "";
			select.appendChild(empty);
		}
		for (const value of setting.enum || []) {
			const option = el("option", "", value);
			option.value = value;
			select.appendChild(option);
		}
		select.addEventListener("change", () => {
			if (select.value === "") {
				post("reset", { id: setting.id });
			} else {
				post("update", { id: setting.id, value: select.value });
			}
		});
		control.appendChild(select);
		return () => {
			const value = effectiveValue(setting);
			select.value = value === undefined ? "" : String(value);
		};
	}

	function renderNumber(control, setting) {
		const input = /** @type {HTMLInputElement} */ (el("input"));
		input.type = "number";
		if (setting.minimum !== undefined) {
			input.min = String(setting.minimum);
		}
		if (setting.maximum !== undefined) {
			input.max = String(setting.maximum);
		}
		input.step = setting.type === "integer" ? "1" : "any";
		input.addEventListener("change", () => {
			const num = Number(input.value);
			const invalid =
				input.value.trim() === "" ||
				!isFinite(num) ||
				(setting.minimum !== undefined && num < setting.minimum) ||
				(setting.maximum !== undefined && num > setting.maximum);
			input.classList.toggle("invalid", invalid);
			if (invalid) {
				return;
			}
			post("update", { id: setting.id, value: num });
		});
		control.appendChild(input);
		return () => {
			const value = effectiveValue(setting);
			input.value = value === undefined ? "" : String(value);
			input.classList.remove("invalid");
		};
	}

	function renderString(control, setting) {
		const input = /** @type {HTMLInputElement} */ (el("input"));
		input.type = "text";
		const example = (setting.examples && setting.examples[0]) || setting.default;
		if (example !== undefined) {
			input.placeholder = String(example);
		}
		input.addEventListener("change", () => {
			const value = input.value.trim();
			if (value === "") {
				// 空にしたらキー削除（既定値に戻す）
				if (isModified(setting)) {
					post("reset", { id: setting.id });
				}
				return;
			}
			if (setting.pattern && !new RegExp(setting.pattern).test(value)) {
				input.classList.add("invalid");
				showToast(strings.invalidValue + ": " + setting.id);
				return;
			}
			input.classList.remove("invalid");
			post("update", { id: setting.id, value: value });
		});
		control.appendChild(input);
		return () => {
			const value = effectiveValue(setting);
			input.value = value === undefined ? "" : String(value);
			input.classList.remove("invalid");
		};
	}

	function renderStringArray(control, setting) {
		const editor = el("div", "array-editor");
		const rows = el("div");
		editor.appendChild(rows);
		const addButton = el("button", "add-button", strings.add);
		editor.appendChild(addButton);
		control.appendChild(editor);

		function commit() {
			const items = [];
			for (const input of rows.querySelectorAll("input")) {
				const value = input.value.trim();
				if (value.length > 0) {
					items.push(value);
				}
			}
			post("update", { id: setting.id, value: items });
		}

		function buildRow(value) {
			const rowEl = el("div", "array-row");
			const input = /** @type {HTMLInputElement} */ (el("input"));
			input.type = "text";
			input.value = value;
			input.addEventListener("change", commit);
			const removeButton = el("button", "row-button", "✕");
			removeButton.title = strings.remove;
			removeButton.addEventListener("click", () => {
				rowEl.remove();
				commit();
			});
			rowEl.appendChild(input);
			rowEl.appendChild(removeButton);
			return rowEl;
		}

		addButton.addEventListener("click", () => {
			const rowEl = buildRow("");
			rows.appendChild(rowEl);
			rowEl.querySelector("input").focus();
		});

		return () => {
			rows.textContent = "";
			for (const item of toStringArray(effectiveValue(setting))) {
				rows.appendChild(buildRow(item));
			}
		};
	}

	function renderObjectArray(control, setting) {
		const fields = setting.itemFields || [];
		const editor = el("div", "array-editor");
		const table = el("table", "pairs-table");
		const thead = el("thead");
		const headRow = el("tr");
		for (const field of fields) {
			const th = el("th", "", field.key);
			th.title = field.description;
			headRow.appendChild(th);
		}
		headRow.appendChild(el("th"));
		thead.appendChild(headRow);
		table.appendChild(thead);
		const tbody = el("tbody");
		table.appendChild(tbody);
		editor.appendChild(table);
		const addButton = el("button", "add-button", strings.addPair);
		editor.appendChild(addButton);
		editor.appendChild(el("p", "hint", strings.incompletePairHint));
		control.appendChild(editor);

		function rowData(tr) {
			const data = {};
			let complete = true;
			for (const input of tr.querySelectorAll("input")) {
				const key = input.dataset.key;
				const value = input.value.trim();
				const field = fields.find((f) => f.key === key);
				data[key] = value;
				if (field && field.required && value === "") {
					complete = false;
				}
				if (field && field.pattern && value !== "" && !new RegExp(field.pattern).test(value)) {
					input.classList.add("invalid");
					complete = false;
				} else {
					input.classList.remove("invalid");
				}
			}
			return { data: data, complete: complete };
		}

		function commit() {
			const items = [];
			for (const tr of tbody.querySelectorAll("tr")) {
				const result = rowData(tr);
				const allEmpty = Object.values(result.data).every((v) => v === "");
				if (allEmpty) {
					continue;
				}
				if (!result.complete) {
					// 未完成行（必須欠け・パターン不一致）が残っている間は保存しない
					return;
				}
				// __origIndex: この行が描画時に対応していた既存配列のインデックス。
				// 拡張側が UI 列に無いキー（copyAssets 等）の引き継ぎ元を特定するために使う
				if (tr.dataset.origIndex !== undefined && tr.dataset.origIndex !== "") {
					result.data.__origIndex = Number(tr.dataset.origIndex);
				}
				items.push(result.data);
			}
			post("update", { id: setting.id, value: items });
		}

		function buildRow(item, origIndex) {
			const tr = el("tr");
			if (typeof origIndex === "number") {
				tr.dataset.origIndex = String(origIndex);
			}
			for (const field of fields) {
				const td = el("td");
				const input = /** @type {HTMLInputElement} */ (el("input"));
				input.type = "text";
				input.dataset.key = field.key;
				input.classList.toggle("dir-input", field.key.endsWith("Dir"));
				input.value = item && item[field.key] !== undefined ? String(item[field.key]) : "";
				if (field.examples && field.examples[0] !== undefined) {
					input.placeholder = String(field.examples[0]);
				}
				input.addEventListener("change", commit);
				td.appendChild(input);
				tr.appendChild(td);
			}
			const td = el("td");
			const removeButton = el("button", "row-button", "✕");
			removeButton.title = strings.remove;
			removeButton.addEventListener("click", () => {
				tr.remove();
				commit();
			});
			td.appendChild(removeButton);
			tr.appendChild(td);
			return tr;
		}

		addButton.addEventListener("click", () => {
			const tr = buildRow(null, undefined);
			tbody.appendChild(tr);
			tr.querySelector("input").focus();
		});

		return () => {
			tbody.textContent = "";
			const value = effectiveValue(setting);
			const items = Array.isArray(value) ? value : [];
			items.forEach((item, index) => {
				tbody.appendChild(buildRow(item, index));
			});
		};
	}

	function renderUnsupported(control, setting) {
		const wrapper = el("div", "json-fallback");
		const pre = el("pre");
		const editButton = el("button", "link-button", strings.editInJson);
		editButton.addEventListener("click", () => post("openJson", {}));
		wrapper.appendChild(pre);
		wrapper.appendChild(editButton);
		control.appendChild(wrapper);
		return () => {
			const value = effectiveValue(setting);
			pre.textContent = value === undefined ? "—" : JSON.stringify(value);
		};
	}

	const CONTROL_RENDERERS = {
		boolean: renderBoolean,
		enum: renderEnum,
		integer: renderNumber,
		number: renderNumber,
		string: renderString,
		stringArray: renderStringArray,
		objectArray: renderObjectArray,
		unsupported: renderUnsupported,
	};
})();
