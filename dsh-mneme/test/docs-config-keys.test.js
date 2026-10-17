// 「CONFIGURATION.md 是全键参考」这句声明需要一条闸门，否则它会慢慢变成谎话：
// 2026-10 审计实测有 11 个 schema 键（graph 组 8 个、sensitiveScanEnabled、
// injectTimePrefix、actionPipelineEnabled）在文档与双 README 里一个字都没有，
// 而它们里有安全开关。锁法：从 Config({}) 的默认值深挖叶子键，要求每个键名
// （或它的父路径，用于 heatTypeDecay 这类整表描述）在文档里出现。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Config } from "../src/config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const doc = readFileSync(path.join(root, "docs", "CONFIGURATION.md"), "utf8");
const cfgSrc = readFileSync(path.join(root, "src", "config.js"), "utf8");

function leafKeys(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) { out.push(...leafKeys(v, p)); continue; }
    out.push({ path: p, leaf: k, parent: prefix || "" });
  }
  return out;
}

test("CONFIGURATION.md 覆盖 schema 的每一个键", () => {
  const keys = leafKeys(Config({}), "");
  assert.ok(keys.length > 150, "键枚举失败会静默返回 0 项，先锁下限");
  const missing = keys.filter((k) => !doc.includes(k.leaf) && !(k.parent && doc.includes(k.parent)));
  assert.deepEqual(missing.map((m) => m.path), []);
});

test("LIGHT_MODE_OFF 的每一项都写进了文档的轻量档清单", () => {
  // LIGHT_MODE_OFF 没有导出，只能解析源码文本；先锁解析结果的长度，防止
  // 正则失配时这个用例变成「空数组 ⊂ 文档」的永真断言。
  const m = cfgSrc.match(/const LIGHT_MODE_OFF = \[([\s\S]*?)\];/);
  assert.ok(m, "LIGHT_MODE_OFF 应从 src/config.js 中解析出来");
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(names.length >= 20, "解析到 " + names.length + " 项，少于预期的 21 项");
  const missing = names.filter((n) => !doc.includes(n));
  assert.deepEqual(missing, []);
});
