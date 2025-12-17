const { markdownParser } = require('./out/core/markdown/parser');

const testConfig = { sync: { autoMarkerLevel: 2 } };

const md1 = `---
title: Test Document
---

これはフロントマター直後の本文です。

この内容は最初のユニットに含まれるべきです。

## 見出し1

見出し1の本文
`;

console.log('=== Test 1: Frontmatter + Content + Heading ===');
const parsed1 = markdownParser.parse(md1, testConfig);
console.log('Units count:', parsed1.units.length);
parsed1.units.forEach((unit, idx) => {
  console.log(`\nUnit ${idx}:`);
  console.log('  Marker:', unit.marker);
  console.log('  Title:', unit.title);
  console.log('  Level:', unit.level);
  console.log('  Content:', unit.content.substring(0, 100).replace(/\n/g, '\\n'));
});

const md2 = `---
title: Test Document
---

<!-- mdait abc123 -->

マーカー直後の本文です。

この内容も保持されるべきです。

## 見出し1

見出し1の本文
`;

console.log('\n\n=== Test 2: Frontmatter + Marker + Content + Heading ===');
const parsed2 = markdownParser.parse(md2, testConfig);
console.log('Units count:', parsed2.units.length);
parsed2.units.forEach((unit, idx) => {
  console.log(`\nUnit ${idx}:`);
  console.log('  Marker:', unit.marker);
  console.log('  Title:', unit.title);
  console.log('  Level:', unit.level);
  console.log('  Content:', unit.content.substring(0, 100).replace(/\n/g, '\\n'));
});
