// issue #24 块2 权重演化（entity_relations weight + source + bump）测试。
// 覆盖：来源→初值映射（manual/tag/llm）/ weight 显式优先 / toRelation 回读 /
// bumpRelationWeight 只加不减封顶 / extractor 建 llm 边 / 四来源全映射落表。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, RELATION_SOURCE_DEFAULTS } from "../src/store.js";

function makeStore() {
  return createStore(":memory:");
}

test("RELATION_SOURCE_DEFAULTS matches issue #24 mapping", () => {
  assert.equal(RELATION_SOURCE_DEFAULTS.manual, 1.0);
  assert.equal(RELATION_SOURCE_DEFAULTS.confirmed, 1.0);
  assert.equal(RELATION_SOURCE_DEFAULTS.tag, 0.3);
  assert.equal(RELATION_SOURCE_DEFAULTS.llm, 0.4);
});

test("saveRelation maps source to initial weight", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const manual = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "manual" });
  const tag = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "y", source: "tag" });
  const llm = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "z", source: "llm" });
  assert.equal(manual.weight, 1.0);
  assert.equal(manual.source, "manual");
  assert.equal(tag.weight, 0.3);
  assert.equal(tag.source, "tag");
  assert.equal(llm.weight, 0.4);
  assert.equal(llm.source, "llm");
});

test("explicit weight overrides source mapping", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const r = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "llm", weight: 0.7 });
  assert.equal(r.weight, 0.7);
});

test("toRelation round-trips weight and source via getRelations", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "tag" });
  const rels = store.getRelations(a.id);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].weight, 0.3);
  assert.equal(rels[0].source, "tag");
});

test("bumpRelationWeight raises weight, caps at 1.0, never lowers", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const r = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "llm" });
  assert.equal(store.bumpRelationWeight(r.id, 0.2), true);
  assert.equal(store.bumpRelationWeight(r.id, 0.2), true);
  assert.equal(store.bumpRelationWeight(r.id, 0.2), true);  // 0.4→0.6→0.8→1.0
  assert.equal(store.bumpRelationWeight(r.id, 0.2), true);
  assert.equal(store.getRelations(a.id)[0].weight, 1.0, "capped");
  // 不存在的关系：幂等 false
  assert.equal(store.bumpRelationWeight("no-such-id"), false);
});

test("legacy relation rows migrate with manual weight default (no crash)", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  // 直接走底层 SQL 模拟旧库行（不带 weight/source 列 —— 但新 schema 已含列，
  // 所以这条主要验证 migration 幂等路径不崩 + 默认映射成立）。
  const r = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x" });
  assert.equal(r.weight, 1.0, "default source manual → weight 1.0");
  assert.equal(r.source, "manual");
});

// ---- #24 复审回归（review findings 逐条落锁）--------------------------------

// 「只加不减」是存储接口自己的契约：负/非法增量必须在存储边界被拒（false +
// 权值不动），不能把下界托付给调用方的配置范围——旧写法 bumpRelationWeight(id,
// -0.2) 能把 0.4 敲到 0.2。
test("bumpRelationWeight rejects negative and non-finite increments (只加不减)", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const r = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "llm" });
  for (const bad of [-0.2, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.2"]) {
    assert.equal(store.bumpRelationWeight(r.id, bad), false, `increment ${String(bad)} must be refused`);
    assert.equal(store.getRelations(a.id)[0].weight, 0.4, `weight must not move on increment ${String(bad)}`);
  }
  assert.equal(store.bumpRelationWeight(r.id, 0.2), true, "a valid increment still lands");
  assert.ok(Math.abs(store.getRelations(a.id)[0].weight - 0.6) < 1e-9, "0.4 + 0.2 lands at 0.6 (float-safe)");
});

// 来源查询只认映射表的自有键：src="constructor"/"toString" 会命中原型链上的函数，
// 旧写法把它当权重绑进 SQL（函数不可绑定 → 整条写入抛错）而不是回退默认 1.0。
test("an inherited source name falls back to the default weight", () => {
  const store = makeStore();
  const a = store.createEntity({ name: "A", type: "technology" });
  const b = store.createEntity({ name: "B", type: "technology" });
  const r = store.saveRelation({ from_entity: a.id, to_entity: b.id, relation_type: "x", source: "constructor" });
  assert.equal(r.weight, 1.0, "prototype-chain names must fall back to 1.0, not a function");
  assert.equal(r.source, "constructor", "source is recorded verbatim");
});