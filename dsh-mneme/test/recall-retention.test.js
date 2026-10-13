import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStore } from "../src/store.js";

// 2026-10-14 找回：recall_runs 的滚动清理（函数 + 启动调用）在 dd0ed78「release:
// v0.7.12」里被整块弄丢，而配置键 recallRetentionDays、README.md 与
// docs/CONFIGURATION.md 一直宣称它有保留期 —— 于是本机那张表涨到 18,442 行、
// 跨度 2026-09-08 → 2026-10-13，只增不减，没人发现。
//
// 这组测试故意分两半，因为**弄丢的正是「两半都在」这件事**：
//   1. 行为锁：函数真的删对行、边界正确、空表不炸；
//   2. 接线锁：index.js 的启动块真的调它，且读的是装配后的 cfg（不是 rawCfg）。
// 只锁 1 不锁 2，函数写得再对也没人调；只锁 2 不锁 1，调用调的可能是空壳。
// 第二半用源码文本断言，理由与 test/client.test.js 的 bilingual 锁同款：这是
// 「接线还在不在」的问题，运行时冒烟测不到一个**在运维时才会跑**的启动分支。

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (name) => readFileSync(join(here, "..", "src", name), "utf8");

function seedRun(store, { query, createdAt }) {
  store.saveRecallRun({
    query,
    mode: "auto",
    topK: 5,
    threshold: null,
    candidates: [],
    created_at: createdAt
  });
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test("保留期：删掉窗口外的行、留下窗口内的行，返回值是真实删除数", () => {
  const store = createStore(":memory:");
  seedRun(store, { query: "老", createdAt: daysAgo(120) });
  seedRun(store, { query: "也老", createdAt: daysAgo(91) });
  seedRun(store, { query: "新", createdAt: daysAgo(89) });
  seedRun(store, { query: "很新", createdAt: daysAgo(1) });

  const removed = store.purgeRecallRunsOlderThan(90);
  assert.equal(removed, 2, "只有窗口外的两行该被删");

  // 两侧都排过再比：assert 的是「留下了哪两行」，不是它们的物理顺序
  const left = store.listRecallRunsSince(daysAgo(3650)).rows.map((r) => r.query).sort();
  assert.deepEqual(left, ["很新", "新"].sort());
  store.close();
});

test("保留期：边界按字典序比较，窗口内的留、窗口外的删（两侧各留 1 小时裕量）", () => {
  const store = createStore(":memory:");
  // 不骑刀刃：cutoff 是在**清理那一刻**用 Date.now() 现算的，而造数据也取一次
  // Date.now()，测试跑几毫秒就足以让「正好 90 天前」翻到界外。这里两侧各留
  // 1 小时，锁的是比较方向（`created_at < cutoff` 才删），不是毫秒级巧合。
  const boundary = 90 * 86400000;
  seedRun(store, { query: "窗口内一小时", createdAt: new Date(Date.now() - boundary + 3600000).toISOString() });
  seedRun(store, { query: "窗口外一小时", createdAt: new Date(Date.now() - boundary - 3600000).toISOString() });

  const removed = store.purgeRecallRunsOlderThan(90);
  assert.equal(removed, 1, "越过界的才删，贴近界的要留");
  assert.deepEqual(store.listRecallRunsSince(daysAgo(3650)).rows.map((r) => r.query), ["窗口内一小时"]);
  store.close();
});

test("保留期：空表返回 0，不抛（清理是 bookkeeping，不许挡启动）", () => {
  const store = createStore(":memory:");
  assert.equal(store.purgeRecallRunsOlderThan(90), 0);
  store.close();
});

test("接线锁：index.js 启动块真的调 purgeRecallRunsOlderThan，且读装配后的 cfg", () => {
  const index = srcText("index.js");
  assert.match(index, /store\.purgeRecallRunsOlderThan\(recallRetentionDays\)/,
    "启动期必须真的调用清理——这对曾在 dd0ed78 里双双蒸发");
  assert.match(index, /cfg\.recallRetentionDays/,
    "必须读装配后的 cfg（面板改保留期才生效），不能读 rawCfg");
  assert.match(index, /catch \{ \/\* non-fatal \*\/ \}/,
    "清理失败不许挡插件启动");
  // 就近确认它落在同一族启动清理之间：失败表 → llm_audit → distill → recall_runs
  const at = index.indexOf("store.purgeRecallRunsOlderThan");
  const llm = index.indexOf("store.deleteOldLlmAudits");
  const distill = index.indexOf("store.clearDistillRecords");
  assert.ok(llm > 0 && distill > 0 && at > llm, "recall_runs 清理应排在 llm_audit 之后");
  assert.ok(at > distill, "recall_runs 清理应排在 distill_records 之后（与现有启动顺序一致）");
});

test("接线锁：store.js 导出 purgeRecallRunsOlderThan（函数存在但没导出同样是断线）", () => {
  const store = srcText("store.js");
  assert.match(store, /function purgeRecallRunsOlderThan\(days\)/);
  assert.match(store, /^\s*purgeRecallRunsOlderThan,\s*$/m, "必须在 createStore 的返回对象里导出");
  assert.match(store, /DELETE FROM recall_runs WHERE created_at < \?/);
});

test("接线锁：配置键与文档对外宣称的保留期一致（键还在、默认 90 天）", () => {
  const cfgText = srcText("config.js");
  assert.match(cfgText, /recallRetentionDays: z\.natural\(\)\.min\(1\)\.max\(3650\)\.default\(90\)/,
    "配置键被改或删掉时，这条和文档一起要动——别让文档继续说谎");
});
