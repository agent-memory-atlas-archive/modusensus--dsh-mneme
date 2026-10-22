// 「外来记忆不被改写」的行为锁 + 静态锁。
// 行为锁盯汇流口：saveWithDedupe 是 appendContent 改写的总入口（蒸馏路径与
// _mergeInto 显式目标都从这过），堵在这里等于在所有写入侧同时封口。
// 静态锁盯池子：巩固/降级读的是各自的行池，堵了汇流口不等于堵了它们——
// 池子里还有 setArchived / demoteToSummary 这些不经 saveWithDedupe 的动作。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { IMPORTED_SOURCE, isImportedRow } from "../src/memory-source.js";

const here = dirname(fileURLToPath(import.meta.url));

test("the predicate is the only definition of foreign-ness", () => {
  assert.equal(IMPORTED_SOURCE, "imported");
  assert.equal(isImportedRow({ source: "imported" }), true);
  assert.equal(isImportedRow({ source: "dream" }), false);
  assert.equal(isImportedRow(null), false);
  assert.equal(isImportedRow({ source: "Imported" }), false); // 精确匹配，不做大小写魔法
});

test("saveWithDedupe never merges into an imported row", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-guard-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const foreign = store.save({ type: "decision", title: "选 SQLite", content: "对方的原文", tags: [], source: IMPORTED_SOURCE });
    const before = store.getById(foreign.id);
    const out = service.saveWithDedupe({ type: "decision", title: "选 SQLite", content: "我自己的新结论", tags: [] });
    assert.equal(out.action, "created", "same title+scope must NOT physically merge into a foreign row");
    assert.notEqual(out.memory.id, foreign.id);
    const after = store.getById(foreign.id);
    assert.equal(after.content, before.content);
    assert.equal(after.updated_at, before.updated_at, "a foreign row's updated_at must not move");
  } finally {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
