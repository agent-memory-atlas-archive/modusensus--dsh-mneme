// 「外来记忆不被改写」的行为锁 + 静态锁。
// 行为锁盯汇流口：saveWithDedupe 是 appendContent 改写的总入口（蒸馏路径与
// _mergeInto 显式目标都从这过），堵在这里等于在所有写入侧同时封口。
// 静态锁盯池子：巩固/降级读的是各自的行池，堵了汇流口不等于堵了它们——
// 池子里还有 setArchived / demoteToSummary 这些不经 saveWithDedupe 的动作。
// 静态锁也盯汇流口本身（下方 SERVICE_SITES）：池子清单归 B2，service.js 不在它那九处里。
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

// 第二条闸门（显式目标 _mergeInto）：调用方点名要并入哪一行，(type, title) 候选集那条
// 路根本不参与。今天生产里唯一点名它的是蒸馏去重（#127，src/summarize.js 找候选时按
// source 过滤，点不到 imported 行），工具面 / 面板 / standalone 三条口各自重建字段表，
// organize 的载荷被 normalizeCandidate 白名单剥掉（#231 的锁）——这道闸门现在是惰性的，
// 它守的是「任何能报出行 id 的调用方」这条契约，不是给某条现有路径打补丁。
// 标题故意与外来行不同（语义近重复本来就不同题，同形状见 test/scope-storage.test.js 的
// 显式目标用例）：摘掉候选集那道闸门时本用例仍绿，摘掉显式目标这道才红——两条行为锁
// 各咬一处，红了就能直接定位是哪道闸门被改坏。
test("saveWithDedupe never merges into an imported row named by _mergeInto", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-imported-merge-into-"));
  const store = createStore(join(dir, "memory.db"));
  try {
    const service = createService({ store, mirror: null, config: {} });
    const foreign = store.save({ type: "decision", title: "选 SQLite", content: "对方的原文", tags: [], source: IMPORTED_SOURCE });
    const before = store.getById(foreign.id);
    const out = service.saveWithDedupe({
      type: "decision",
      title: "SQLite 的并发写入够用",
      content: "我自己的新结论",
      tags: [],
      _mergeInto: foreign.id
    });
    assert.equal(out.action, "created", "an explicit _mergeInto at a foreign row must degrade to a miss");
    assert.notEqual(out.memory.id, foreign.id);
    assert.equal(out.memory.content, "我自己的新结论", "the new row carries only our own content");
    const after = store.getById(foreign.id);
    assert.equal(after.content, before.content, "a foreign row's content must not be appended to");
    assert.equal(after.updated_at, before.updated_at, "a foreign row's updated_at must not move");
    assert.equal((after.content_history ?? []).length, (before.content_history ?? []).length,
      "merging into a foreign row would also push its content_history");
  } finally {
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// 字面量锁：钉死汇流口两处闸门的形状。它不证明闸门有效（那是上面两条行为锁的活），
// 它防的是将来某次重构把其中一处改名、挪进别的文件或干脆删掉——上面两条各自只测得到
// 一条路，删掉另一条闸门要等到有人专门给它写用例才会被抓到，而这条锁当场就红。
// 它锁字面量，所以谓词变量改名 / 参数名换掉也算红：那是「实现漂了，锁跟着走」，
// 不是误报（改的人必须知道自己动的是哪两处）。
const SERVICE_SITES = [
  ["src/service.js", ".filter((m) => !isImportedRow(m))"],
  ["src/service.js", "!isImportedRow(explicitCandidate)"],
];

test("the saveWithDedupe choke point keeps both guard sites", () => {
  for (const [file, needle] of SERVICE_SITES) {
    assert.ok(readFileSync(resolve(here, "..", file), "utf8").includes(needle),
      `${file} must keep the imported-row guard at the choke point: ${needle}`);
  }
});
