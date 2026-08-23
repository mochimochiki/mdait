"use strict";
/*
 * 移設先へ橋渡しするだけの薄い受け皿。
 *
 * 本体は scripts/lab/vscode-shim.js に移した。ここは run-sweep.js と probe-robustness.js が
 * まだ `require("./vscode-shim")` と書いているあいだだけ残す。
 * この2本を scripts/lab/scenarios/ へ移し終えたら、このファイルは消すこと。
 */
module.exports = require("../lab/vscode-shim.js");
