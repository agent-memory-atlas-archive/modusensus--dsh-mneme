import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";
import { createStore } from "../src/store.js";

// 与 test/recall-retention.test.js 同款，这组测试故意分两半，因为弄丢的正是「两半
// 都在」：
// 1. 行为锁——deleteOldFailures 真的删对行、比较方向正确、空表不炸。
// 2. 接线锁——src/index.js 的启动块真的调它，且读的是装配后的 cfg。第二半用源码
//    文本断言，理由与 test/client.test.js 的 bilingual 锁同款：启动期清理只在运维
//    时才会跑到，运行时冒烟测不到「这一行被挪回装配之前了」。
//
// 这一批补的是「写死」这条欠账：failure_memories 的清理此前排在 createStore 之后、
// cfg 装配之前，天数硬编码 90，是四张启动期清理表里唯一没有键可陈述的一张。

const here = dirname(fileURLToPath(import.meta.url));
const srcText = (name) => readFileSync(join(here, "..", "src", name), "utf8");
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// saveFailure 只认当前时刻，所以插进去之后把 created_at 改写成指定时刻。
function seedFailure(store, createdAt, id) {
  store.saveFailure({ id, failure_type: "user_correction", expected: "新值", actual: "旧值" });
  store.db.prepare("UPDATE failure_memories SET created_at = ? WHERE id = ?").run(createdAt, id);
  return id;
}

test("deleteOldFailures 删掉窗口外的行、留下窗口内的行", () => {
  const store = createStore(":memory:");
  seedFailure(store, daysAgo(200), "old-1");
  seedFailure(store, daysAgo(120), "old-2");
  seedFailure(store, daysAgo(10), "fresh-1");
  seedFailure(store, daysAgo(1), "fresh-2");

  assert.equal(store.listFailures().length, 4);
  const removed = store.deleteOldFailures(daysAgo(90));
  assert.equal(removed, 2);
  // assert 的是留下了哪两行，不是物理顺序
  assert.deepEqual(store.listFailures().map((r) => r.id).sort(), ["fresh-1", "fresh-2"]);
});

test("边界两侧各留 1 小时裕量：锁的是比较方向不是毫秒级巧合", () => {
  const store = createStore(":memory:");
  const boundary = 90 * 86400000;
  // cutoff 是在清理那一刻现算的，所以不骑刀刃——两侧各让开一小时。
  seedFailure(store, new Date(Date.now() - boundary + 3600000).toISOString(), "just-inside");
  seedFailure(store, new Date(Date.now() - boundary - 3600000).toISOString(), "just-outside");

  const removed = store.deleteOldFailures(new Date(Date.now() - boundary).toISOString());
  assert.equal(removed, 1, "只有 created_at < cutoff 的那一行该走");
  assert.deepEqual(store.listFailures().map((r) => r.id), ["just-inside"]);
});

test("空表返回 0 且不抛", () => {
  const store = createStore(":memory:");
  assert.equal(store.deleteOldFailures(daysAgo(90)), 0);
});

test("配置键 reflectionFailureRetentionDays：默认 90、单位是天、边界钉死", () => {
  assert.equal(Config({}).reflectionFailureRetentionDays, 90, "默认值必须与旧行为一致");
  assert.equal(Config({ reflectionFailureRetentionDays: 30 }).reflectionFailureRetentionDays, 30);
  assert.equal(Config({ reflectionFailureRetentionDays: 3650 }).reflectionFailureRetentionDays, 3650);
  // 0 天会把这张表压成「只留最近一次」，等于废掉「挖掘重复纠正模式」的用途
  assert.throws(() => Config({ reflectionFailureRetentionDays: 0 }));
  assert.throws(() => Config({ reflectionFailureRetentionDays: 3651 }));
  assert.throws(() => Config({ reflectionFailureRetentionDays: 2.5 }));

  // 形状锁：与 recallRetentionDays 一族同形，别各自演化
  assert.match(
    srcText("config.js"),
    /reflectionFailureRetentionDays: z\.natural\(\)\.min\(1\)\.max\(3650\)\.default\(90\)/
  );
  // 文档面同步：README 的键表与 docs/CONFIGURATION.md 的键表是用户唯一能读到
  // 这个键的地方。用布尔断言而不是 assert.match——断言失败时 node:test 会把整个
  // 文件正文打进 diff，几百行文档刷满输出，反而看不见失败点。
  for (const doc of ["README.md", "docs/CONFIGURATION.md"]) {
    const text = readFileSync(join(here, "..", doc), "utf8");
    assert.ok(
      text.includes("`reflectionFailureRetentionDays`"),
      `${doc} 必须列出 reflectionFailureRetentionDays —— 加了键不改文档正是这一族欠账的来源`
    );
  }
});

test("接线锁：启动期失败表清理排在 cfg 装配之后，读键而不是写死的 90 天", () => {
  const index = srcText("index.js");
  const callAt = index.indexOf("store.deleteOldFailures(");
  assert.ok(callAt > 0, "index.js 必须调用 store.deleteOldFailures");

  // 装配前读 rawCfg 会漏掉面板/预设合进来的值；失败表此前正好排在装配之前。
  const cfgAt = index.indexOf("const cfg = { ...applyLightModePreset(");
  assert.ok(cfgAt > 0 && cfgAt < callAt, "清理必须排在 cfg 装配之后，否则读不到配置值");

  const block = index.slice(callAt - 700, callAt + 200);
  assert.match(block, /cfg\.reflectionFailureRetentionDays/, "天数必须取自配置键");
  assert.match(block, /Number\.isInteger\(/, "非法值要能落回默认，别让 NaN 传给 SQL");
  assert.match(block, /failureRetentionDays \* 86400000/, "键的单位是天，换算在这儿");

  assert.ok(
    !/Date\.now\(\) - 90 \* 86400000/.test(index),
    "写死的 90 天不能回来——这正是本批在修的那条欠账"
  );
});
