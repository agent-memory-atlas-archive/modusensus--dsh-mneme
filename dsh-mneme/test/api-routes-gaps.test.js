import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApi } from "../src/api.js";
import { createSettings } from "../src/settings.js";

// 覆盖 PR#73 删测后遗留的三个存活 API 空白（v0.7.16 回归补测）：
//   /api/dsh-mneme/delete         面板删记忆（POST + auth + 存在性 404）
//   /api/dsh-mneme/entities       实体目录（只读、limit 夹取）
//   /api/dsh-mneme/external-api   独立服务配置（GET 发 token / PUT 校验）
// 这三个路由在 src/api.js 里一直在跑，只是丢了测试。

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

function req(path, method = "GET", body = null) {
  const r = new EventEmitter();
  r.url = path;
  r.method = method;
  r.headers = {};
  if (body !== null) {
    process.nextTick(() => {
      r.emit("data", Buffer.from(JSON.stringify(body)));
      r.emit("end");
    });
  }
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
  return { store, service, routes, settings };
}

function handler(routes, path) {
  return routes.find((r) => r.path === path);
}

// ---------------------------------------------------------------------------
// /api/dsh-mneme/delete
// ---------------------------------------------------------------------------
test("delete is auth-gated and rejects non-POST", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/delete", "POST", { id: "x" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  // 带 token 但 GET → 404
  res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "GET");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
});

test("delete validates id and reports missing/unknown 404", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  // 空 id → 400
  let res = new FakeRes();
  let ok = req("/api/dsh-mneme/delete", "POST", { id: "  " });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "missing-id");

  // 不存在的 id → 404（store.remove 静默，靠前置 getById 区分）
  res = new FakeRes();
  ok = req("/api/dsh-mneme/delete", "POST", { id: "no-such-memory" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, "not-found");

  // 确认没被误删
  assert.equal(service.count(), 0);
});

test("delete removes an existing memory", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/delete");

  const { memory } = service.saveWithDedupe({ type: "project", title: "要删的", content: "删掉我" });
  assert.ok(service.getById(memory.id));

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/delete", "POST", { id: memory.id });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(service.getById(memory.id), undefined);
  assert.equal(service.count(), 0);
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/entities
// ---------------------------------------------------------------------------
test("entities directory is read-only and returns empty list", async () => {
  const { routes } = setup();
  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { entities: [], total: 0 });
});

test("entities lists seeded entities without auth", async () => {
  const { routes, service } = setup("secret-token"); // 有 token 但读路由不校验
  service.createEntity({ name: "SQLite", type: "technology" });
  service.createEntity({ name: "记忆", type: "concept" });

  const route = handler(routes, "/api/dsh-mneme/entities");
  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/entities"), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 2);
  const names = data.entities.map((e) => e.name).sort();
  assert.deepEqual(names, ["SQLite", "记忆"]);
  for (const e of data.entities) {
    assert.ok(e.type, "each entity carries a type");
    assert.ok(Number.isInteger(e.mention_count));
  }
});

test("entities clamps limit to [1, 1000]", async () => {
  const { routes, service } = setup();
  for (let i = 0; i < 5; i++) service.createEntity({ name: `e${i}`, type: "concept" });
  const route = handler(routes, "/api/dsh-mneme/entities");

  // 夹取语义：NaN/0 先被 `|| 500` 兜底成 500（0 不再走 max(1,) 下限），
  // 负数才被夹到 1，超限（>1000）夹到 1000。断言按真实实现收紧。
  for (const [qs, want] of [["limit=abc", 5], ["limit=0", 5], ["limit=-10", 1], ["limit=5000", 5]]) {
    const res = new FakeRes();
    await route.handler(req(`/api/dsh-mneme/entities?${qs}`), res);
    const data = JSON.parse(res.body);
    assert.equal(data.entities.length, want, `${qs} → ${want} (got ${data.entities.length})`);
  }
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/external-api
// ---------------------------------------------------------------------------
test("external-api GET materializes and persists a token", async () => {
  const { routes, settings } = setup();
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.ok(typeof cfg.token === "string" && cfg.token.length >= 16, "token is generated");

  // 持久化后二次 GET 返回同一 token
  const res2 = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api"), res2);
  assert.equal(JSON.parse(res2.body).config.token, cfg.token);
  assert.ok(settings.getExternalApi().token, "token persisted to settings kv");
});

test("external-api PUT requires auth and validates port/host", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  // 未带 token → 401
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/external-api", "PUT", { enabled: true }), res);
  assert.equal(res.statusCode, 401);

  // 端口越界 → 400
  res = new FakeRes();
  let ok = req("/api/dsh-mneme/external-api", "PUT", { port: 70000 });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-port");

  // host 带协议 → 400
  res = new FakeRes();
  ok = req("/api/dsh-mneme/external-api", "PUT", { host: "https://example.com" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-host");
});

test("external-api PUT applies valid config and echoes it", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/external-api");

  const res = new FakeRes();
  const ok = req("/api/dsh-mneme/external-api", "PUT", { enabled: true, port: 8790, host: "127.0.0.1" });
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 200);
  const cfg = JSON.parse(res.body).config;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.host, "127.0.0.1");
  assert.ok(typeof cfg.token === "string");
});

// ---------------------------------------------------------------------------
// /api/dsh-mneme/create（#386 第 5 条：面板手动新增记忆）
// ---------------------------------------------------------------------------
// 这些用例锁的是「面板建行」与「工具建行」必须同语义：同一条 saveWithDedupe
// 路径、同一套去重键。历史缺口是面板只有看/改/删/导入，用户想手写一条必须开
// 终端或调外部 API——两条旁路都绕开了面板的去重提示。
test("create is auth-gated and rejects non-POST", async () => {
  const { routes } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  assert.ok(route, "route must be registered");

  // 未带 token → 401（写路由与 /update、/delete 同口径）
  let res = new FakeRes();
  await route.handler(req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, "unauthorized");

  // 带 token 但 GET → 404（不是 405：与既有写路由一致，避免探测路由存在性）
  res = new FakeRes();
  const ok = req("/api/dsh-mneme/create", "GET");
  ok.headers = { authorization: "Bearer secret-token" };
  await route.handler(ok, res);
  assert.equal(res.statusCode, 404);
});

test("create validates type/title/content and refuses document rows", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  const post = async (body) => {
    const r = req("/api/dsh-mneme/create", "POST", body);
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    return res;
  };

  // 未知类型 → 400（TYPES 是唯一真相源，面板不得自己维护第二份白名单）
  let res = await post({ type: "not-a-type", title: "t", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-type");

  // document 是 registerDocument 的专属铸造口（#230）→ 干净 400，不落成 500
  res = await post({ type: "document", title: "t", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "document-requires-register");

  // 空白标题 / 空白正文 → 400（面板是人工输入，空正文只可能是误操作）
  res = await post({ type: "project", title: "   ", content: "c" });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-title");
  res = await post({ type: "project", title: "t", content: "  \n " });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-content");

  // importance 越界 / tags 非字符串数组 → 400，宁拒绝不静默纠正
  res = await post({ type: "project", title: "t", content: "c", importance: 9 });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-importance");
  res = await post({ type: "project", title: "t", content: "c", tags: [1, 2] });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "invalid-tags");

  // 全部被拒后一条都没落库
  assert.equal(service.count(), 0);
});

test("create saves a memory and reports action=created with 201", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");

  const r = req("/api/dsh-mneme/create", "POST", {
    type: "constraint",
    title: "面板手写一条",
    content: "正文",
    importance: 4,
    tags: ["panel"]
  });
  r.headers = { authorization: "Bearer secret-token" };
  const res = new FakeRes();
  await route.handler(r, res);

  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.action, "created");
  assert.equal(body.type, "constraint");
  assert.equal(body.title, "面板手写一条");
  assert.equal(body.importance, 4);
  assert.deepEqual(body.tags, ["panel"]);
  // source 必须能一眼认出是面板写的——详情抽屉把它当「来源」显示
  assert.equal(body.source, "panel");
  assert.ok(service.getById(body.id), "row really exists in the store");
});

test("create merges into an existing row with the same (type, title) and says so", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  service.saveWithDedupe({ type: "project", title: "同标题", content: "原来的正文" });

  const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "同标题", content: "追加的正文" });
  r.headers = { authorization: "Bearer secret-token" };
  const res = new FakeRes();
  await route.handler(r, res);

  // 200 而非 201：并入了既有行，没有新行诞生。面板据此提示「已并入」而不是
  // 「新建成功」——两者对用户是不同的事实。
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.action, "merged");
  assert.equal(service.count(), 1, "no second row was minted");
  assert.ok(service.getById(body.id).content.includes("追加的正文"));
});

test("create maps a denied write to 422 instead of leaking a 500", async () => {
  // #254 写入准入今天在无会话身份时放行（write-admission.js 首行早退），面板路由
  // 恰好不带 _sessionKey，所以这条分支当前到不了。仍然要锁：一旦有人把会话身份接
  // 进面板，落回 toApiList([null]) 会把「被拒」伪装成「服务器出错」——用户看到的
  // 是「新建失败」，实际是准入拒绝，两者的处置完全不同。
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  const original = service.saveWithDedupe;
  service.saveWithDedupe = () => ({ action: "denied", reason: "too-many-writes", memory: null });
  try {
    const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" });
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    assert.equal(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "write-rejected");
    assert.equal(body.reason, "too-many-writes", "the reason must survive: it is what makes the rejection actionable");
  } finally {
    service.saveWithDedupe = original;
  }
});

test("create returns 500 (not a leaked throw) when the store rejects the write", async () => {
  const { routes, service } = setup("secret-token");
  const route = handler(routes, "/api/dsh-mneme/create");
  // 绕过路由校验直达 saveWithDedupe 的守卫：document 行会 throw。这里用打桩
  // 模拟「路由认为合法、存储层仍然拒绝」的那类情况（类型白名单漂移等）。
  const original = service.saveWithDedupe;
  service.saveWithDedupe = () => { throw new Error("invalid memory type: whatever"); };
  try {
    const r = req("/api/dsh-mneme/create", "POST", { type: "project", title: "t", content: "c" });
    r.headers = { authorization: "Bearer secret-token" };
    const res = new FakeRes();
    await route.handler(r, res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, "internal");
  } finally {
    service.saveWithDedupe = original;
  }
});

