// 分享包的面板路由锁。盯四件事：
//   a) policy 归对（token —— 它是全库级读取，与 /export 同门，见 2026-10 审计 P0）；
//   b) token 配上时**不带 token 必须 401**，不是静默放行；
//   c) readBody 返回 null（超 4 MiB，它自己已答 413）时 handler 必须直接 return，
//      不能再答一次 —— 双写响应是 #410 那一类故障；
//   d) 500 必须留下日志：shareReply 把抛错兜成 500，不接 warn 回调时那条 500 是静默的
//      （现场只剩「内部错误」，查不出是哪一次打包炸的）。同款契约见 reclaim 的 500 用例。
// 装配台照 test/api-routes-gaps.test.js 的 reclaimSetup，**必须落文件库**：`:memory:`
// 与文件库在 store.all() 的读侧口径上没差别，但分享包吃的正是「全库含归档/已遗忘」，
// 用内存库时归档位的字节口径与体积水位都摸不到真实数字（同 reclaim 报告的理由）。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

const SHARE_PATH = "/api/dsh-mneme/share";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.body = "";
    this.headers = null;
    // writeHead 计数：双写响应的故障形态是「第二次 writeHead 覆盖掉第一次的状态码」，
    // 只看最终 statusCode 抓不住（413 之后又被 200 盖掉时 body 也换了），要数次数。
    this.heads = 0;
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers;
    this.heads += 1;
    return this;
  }
  end(text) {
    this.body = text ?? "";
    this.emit("end");
    return this;
  }
}

function shareSetup(apiToken = "secret-token", { logger = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-api-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const commands = { add: () => {}, remove: () => {}, list: () => [] };
  const routes = [];
  const ctx = { logger, webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, commands, null, undefined, apiToken, null, null);
  return {
    store, service, routes,
    // 闭包拿 store，不用 this：裸函数调用下 this 是 undefined，异常被吞掉就会变成
    // 「库没关就删目录」的 EPERM（清理失败还说不清原因）。
    close() {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 字节必须在 listener 挂上之后再 emit：EventEmitter 不排队，在 `route.handler` 里
 * readBody 注册 data/end 之前 emit 出去等于什么都没发，readBody 的 promise 永不
 * resolve，整个用例会挂到超时——失败原因还完全看不出跟分享有关。
 */
function shareReq({ method = "POST", url = SHARE_PATH, body = "", authorized = true } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = authorized ? { authorization: "Bearer secret-token" } : {};
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

async function callShare(route, opts = {}) {
  const res = new FakeRes();
  await route.handler(shareReq(opts), res);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
    headers: res.headers,
    heads: res.heads
  };
}

function shareRoute(setup) {
  const route = setup.routes.find((r) => r.path === SHARE_PATH);
  assert.ok(route, "route must exist");
  return route;
}

test("share route is registered with policy token", () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    assert.equal(route.policy, "token");
    assert.equal(route.kind, "exact");
  } finally { s.close(); }
});

test("a configured token gates the share route", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    const denied = await callShare(route, { authorized: false, body: "" });
    assert.equal(denied.status, 401);
    const allowed = await callShare(route, { authorized: true, body: "" });
    assert.equal(allowed.status, 200);
    const pack = allowed.body;
    assert.equal(pack.kind, "mneme.share/v1");
    assert.equal(pack.report.included, 1);
    assert.ok(!("id" in pack.memories[0]));
    // 本侧 sendJson 有 headers 第四参（数据面没有）：Content-Disposition 是面板这张脸
    // 独有的那半，共用层只回 {status, body}，文件名由这里拼——锁它，防止哪天把
    // shareFilename 的连接也一起「统一」掉。
    assert.match(allowed.headers["Content-Disposition"], /^attachment; filename="dsh-mneme-share-\d{8}-[0-9a-f]{8}\.json"$/);
    // 空 body 与「一个字节都不发」同口径：分享的主用法就是按整库口径打。
    const alias = await callShare(route, { body: JSON.stringify({ alias: "桉桉的库" }) });
    assert.equal(alias.status, 200);
    assert.equal(alias.body.alias, "桉桉的库");
    assert.match(alias.body.source_version, /\d/, "包要记下发送方版本，对面按它判兼容");
    assert.ok(Number.isFinite(Date.parse(alias.body.generated_at)));
  } finally { s.close(); }
});

test("GET on the share route is not an open read", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    const out = await callShare(route, { method: "GET", body: "" });
    assert.ok(out.status === 405 || out.status === 404, `GET must not build a pack, got ${out.status}`);
    assert.ok(!out.body || !("memories" in out.body), "GET 不许把包交出去");
  } finally { s.close(); }
});

test("a body this layer cannot read is a 400 with one code, not a pack", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    for (const raw of ["{oops", "[1,2]", "null"]) {
      const out = await callShare(route, { body: raw });
      assert.equal(out.status, 400, `${raw} 必须被拒`);
      assert.equal(out.headers?.["Content-Type"], "application/json; charset=utf-8");
      assert.ok(!("memories" in out.body), "拒答里绝不带包体");
    }
  } finally { s.close(); }
});

test("an oversize body answers 413 exactly once", async () => {
  const s = shareSetup();
  try {
    const route = shareRoute(s);
    s.store.save({ type: "decision", title: "选 SQLite", content: "正文", tags: [] });
    // readBody 超限时会自己答 413 并把 text 解析成 null。handler 若没有
    // `if (text === null) return`，它会拿 null 继续往下走：parseShareBody(null) 是
    // 合法的「空 body」，于是整库进包、再答一次 200 —— 一个响应两写，客户端按
    // 状态码分支时看到的是最后那一次（#410 修过的同一类故障）。
    const out = await callShare(route, { body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal(out.heads, 1, "超限时只许有一次响应写");
    assert.equal(out.status, 413);
    assert.equal(out.body.error, "payload-too-large");
  } finally { s.close(); }
});

test("a throwing pack build answers 500 and leaves a log line", async () => {
  // 不带 logger 也照答 500（shareReply 的 warn 是可选的），但带时必须真的写日志：
  // 否则「500 且无迹可查」这条现场就无从下手。
  const warnings = [];
  const s = shareSetup("secret-token", { logger: { warn: (m) => warnings.push(String(m)) } });
  try {
    const route = shareRoute(s);
    s.service.all = () => { throw new Error("database is locked"); };
    const out = await callShare(route, { body: "" });
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: "internal" }, "对外只有一个码，不带原始错误文本");
    assert.match(warnings.join(" "), /share pack failed/);
    assert.match(warnings.join(" "), /database is locked/, "原始错误文本要留在日志里");
  } finally { s.close(); }
});
