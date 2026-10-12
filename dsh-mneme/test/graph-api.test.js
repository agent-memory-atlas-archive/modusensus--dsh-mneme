import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

// Ego-graph read API (graph panel P1). The routes under test:
//   GET /api/dsh-mneme/semantic/graph/ego?entity=&depth=&limit=
//   GET /api/dsh-mneme/semantic/graph/entity-attrs?entity=
// Both are read-only: they must stay reachable without an apiToken, exactly
// like list/search/semantic.

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path) {
  const r = new EventEmitter();
  r.url = path;
  r.method = "GET";
  r.headers = {};
  return r;
}

function setup(apiToken = "") {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken);
  return { store, service, routes };
}

function graphRoute(routes, path) {
  return routes.find((r) => r.path === path);
}

function buildChain(service, names, linkType = "related_to") {
  // names → entities; each consecutive pair gets one relation. Returns a
  // name→entity map so tests can assert on ids.
  const map = new Map();
  for (const n of names) map.set(n, service.createEntity({ name: n, type: "concept" }));
  for (let i = 0; i < names.length - 1; i++) {
    service.saveRelation({
      from_entity: map.get(names[i]).id,
      to_entity: map.get(names[i + 1]).id,
      relation_type: linkType
    });
  }
  return map;
}

test("ego route is registered and open without apiToken", async () => {
  const { routes } = setup("secret-token");
  const ego = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const attrs = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  assert.ok(ego, "ego route must be registered");
  assert.ok(attrs, "entity-attrs route must be registered");
  // read-only: no 401 even with a token configured
  const res = new FakeRes();
  await ego.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400, "missing param is a 400, not a 401");
});

test("ego depth 1 returns root + direct neighbors with distances", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=1"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.root.name, "A");
  assert.equal(data.nodes.length, 2, "root + B only (C is 2 hops)");
  assert.equal(data.edges.length, 1);
  const b = data.nodes.find((n) => n.name === "B");
  assert.equal(b.distance, 1);
  assert.equal(data.nodes.find((n) => n.name === "A").distance, 0);
  // edge shape: ids + relation_type, memory_id nullable
  const edge = data.edges[0];
  assert.ok(edge.id && edge.from && edge.to);
  assert.equal(edge.relation_type, "related_to");
  assert.equal(edge.memory_id, null);
});

test("ego depth 2 includes 2-hop nodes, not 3-hop", async () => {
  const { routes, service } = setup();
  buildChain(service, ["A", "B", "C", "D"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2"), res);
  const data = JSON.parse(res.body);
  const names = data.nodes.map((n) => n.name).sort();
  assert.deepEqual(names, ["A", "B", "C"], "D is 3 hops away and must be excluded");
  assert.equal(data.nodes.find((n) => n.name === "C").distance, 2);
  assert.equal(data.edges.length, 2);
});

test("ego respects limit and keeps only in-graph edges", async () => {
  const { routes, service } = setup();
  const map = buildChain(service, ["A", "B", "C"]);
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=A&depth=2&limit=2"), res);
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 2, "limit caps node count");
  assert.equal(data.edges.length, 1, "edges to cut nodes are dropped");
});

test("ego reports 404 for unknown entity and 400 without entity", async () => {
  const { routes } = setup();
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=ghost"), res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "entity-not-found");
  res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-entity");
});

test("entity-attrs returns current valid attrs only", async () => {
  const { routes, service } = setup();
  const mem = service.saveWithDedupe({ type: "project", title: "t", content: "c" });
  const entity = service.createEntity({ name: "X", type: "technology" });
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "1", memory_id: mem.id, confidence: 0.9 });
  // a second save of the same key invalidates the first: only one row stays valid
  service.saveAttr({ entity_id: entity.id, attr_key: "version", attr_value: "2", memory_id: mem.id, confidence: 0.8 });
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/entity-attrs");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=X"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.entity.name, "X");
  assert.equal(data.attrs.length, 1);
  assert.equal(data.attrs[0].value, "2", "latest valid attr wins");
  assert.equal(data.attrs[0].confidence, 0.8);
  // unknown / missing entity
  let r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs?entity=nope"), r2);
  assert.equal(r2.statusCode, 404);
  r2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/semantic/graph/entity-attrs"), r2);
  assert.equal(r2.statusCode, 400);
});

test("ego 2-hop traversal work is bounded by limit, not by graph size (#409)", async () => {
  const { routes, service } = setup();
  // star-of-stars: hub → 20 spokes, each spoke → 5 leaves = 121 nodes, 120 edges
  const hub = service.createEntity({ name: "hub", type: "project" });
  for (let i = 0; i < 20; i++) {
    const spoke = service.createEntity({ name: `spoke-${i}`, type: "technology" });
    service.saveRelation({ from_entity: hub.id, to_entity: spoke.id, relation_type: "uses" });
    for (let j = 0; j < 5; j++) {
      const leaf = service.createEntity({ name: `leaf-${i}-${j}`, type: "concept" });
      service.saveRelation({ from_entity: spoke.id, to_entity: leaf.id, relation_type: "related_to" });
    }
  }
  const route = graphRoute(routes, "/api/dsh-mneme/semantic/graph/ego");
  // #409：这条用例原先断言墙钟 < 50ms，而那个「spec §7」预算在仓库文档里找不到出处。
  // 全量并行跑实测最坏 60.4ms，于是它偶发翻车。ego 路由真正要钉住的性质是「遍历工作量
  // 由 limit 卡死、不随图规模增长」——那是个确定性事实：请求内 getRelations 的唯一调用方
  // 就是这次遍历，所以计数即工作量。墙钟只保留一条离群告警（放到最后）。
  const realGetRelations = service.getRelations.bind(service);
  let lookups = 0;
  service.getRelations = (id) => { lookups++; return realGetRelations(id); };
  const res = new FakeRes();
  const start = process.hrtime.bigint();
  await route.handler(req("/api/dsh-mneme/semantic/graph/ego?entity=hub&depth=2&limit=100"), res);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const data = JSON.parse(res.body);
  assert.equal(data.nodes.length, 100, "limit caps the traversal");
  assert.ok(data.edges.length > 0);
  // 两趟（BFS + 边收集）各至多 limit 次，BFS 还会为「已满之后剩下的 frontier」多问几次，
  // 所以上界留到 3×limit；数量级级别的退化会立刻越界。
  assert.ok(lookups <= 300, `traversal work must be bounded by the limit, saw ${lookups} adjacency lookups`);

  // 同一个查询打到约 13× 大的图上：limit 没变，该做的活就不该变。这一条不含时钟。
  const big = setup();
  const bigHub = big.service.createEntity({ name: "hub", type: "project" });
  for (let i = 0; i < 40; i++) {
    const spoke = big.service.createEntity({ name: `s-${i}`, type: "technology" });
    big.service.saveRelation({ from_entity: bigHub.id, to_entity: spoke.id, relation_type: "uses" });
    for (let j = 0; j < 15; j++) {
      const leaf = big.service.createEntity({ name: `l-${i}-${j}`, type: "concept" });
      big.service.saveRelation({ from_entity: spoke.id, to_entity: leaf.id, relation_type: "related_to" });
    }
  }
  const bigReal = big.service.getRelations.bind(big.service);
  let bigLookups = 0;
  big.service.getRelations = (id) => { bigLookups++; return bigReal(id); };
  const bigRes = new FakeRes();
  await graphRoute(big.routes, "/api/dsh-mneme/semantic/graph/ego")
    .handler(req("/api/dsh-mneme/semantic/graph/ego?entity=hub&depth=2&limit=100"), bigRes);
  assert.equal(JSON.parse(bigRes.body).nodes.length, 100, "the same limit caps the bigger graph too");
  assert.ok(bigLookups <= lookups + 100,
    `${1 + 40 + 600} nodes cost ${bigLookups} lookups vs ${lookups} on 121 — work must track the limit, not the graph`);

  // 墙钟只留一条离群告警，不再是规格线：它抓不到的那类退化已由上面的工作量断言确定性钉死，
  // 250ms（≈4× 实测最坏值）只为兜住数量级级别的性能崩塌（#409）。
  assert.ok(ms < 250, `2-hop query took ${ms.toFixed(1)}ms — the work bound above is the lock; 250ms is only an outlier guard`);
});
