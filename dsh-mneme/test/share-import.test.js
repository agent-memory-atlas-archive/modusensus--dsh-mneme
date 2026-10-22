// 导入的动作面。四条锁，一条比一条容易被「顺手重构」拆掉：
//   a) 不改写别人——既有非 imported 行的 updated_at 逐字节不动（决策 2 的直接锁）；
//   b) 幂等——同包第二次导入 created = 0 且不删任何东西；
//   c) 外来行带着守卫要的身份落地（source / 两个 scope），否则车道 B 的九个池子白挡；
//   d) 真的排进了嵌入队列、并在提交后落进 embedding 列（在 transaction 里），否则对面的
//      向量检索吃不到这批。
// 另有三条同样会被「顺手重构」拆掉：撞名清单里的既有那一行必须是收件人自己的行（外来行
// 永远不许当 existing_id）、校验不过时整库无痕、干跑不许冒充「库刚变过」。这三条测的都是
// 收侧要对外讲的读数与其余读侧的可见性——报得出去但没人能看出错，比不测更糟。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { deriveExternalId, importedTagFor, SHARE_KIND } from "../src/share.js";
import { IMPORTED_SOURCE } from "../src/memory-source.js";

const PACK_ID = "f0f0f0f0f0f0f0f0";
// packId 可换是第三个补的用例要的：external_id 的四格里含 pack_id，同 pack_id 的第二份
// 包会被幂等那格吃掉（skipped_existing），那条路径问不出「撞名报给谁」这件事。
const PACK_ID_2 = "a1a1a1a1a1a1a1a1";
const pack = (entries, alias = "桉", packId = PACK_ID) => ({
  kind: SHARE_KIND, pack_id: packId, alias, generated_at: "2026-10-22T00:00:00.000Z",
  source_version: "0.9.4", report: { included: entries.length, skipped: {}, skip_list: [], deduped: 0 },
  memories: entries.map((e) => ({ ...e, external_id: deriveExternalId(packId, e.type, e.title, e.content_hash) }))
});
const entry = (type, title, content) => ({
  type, title, content, tags: ["t"], importance: 4, epistemic_status: "verifiable",
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
  content_hash: "anchor", external_id: deriveExternalId(PACK_ID, type, title, "anchor")
});

// scheduleEmbed 的写回是 embedSingle 的 .then()，异步且不进任何可 await 的出口
// （fire-and-forget 是设计，不是漏的）。所以这里等的是**落库**：轮询到 embedding
// 列真有值为止，等不到就让断言自己红。轮询而不是 await 一个 tick，是因为桩返回的
// promise 与真实 embedder 的调度深度不同，写死 tick 数的用例会在某天多一层 await
// 时静默转红——那类红查起来比这条用例本身还贵。
async function waitFor(pred, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-share-import-"));
  const store = createStore(join(dir, "memory.db"));
  const embedded = [];
  let writes = 0;
  const service = createService({
    store, mirror: null, config: { embeddingModel: "stub" },
    onWrite: () => { writes++; }
  });
  // 方法名照 src/service.js 探测的那两个（schedule ?? embedSingle）：猜错的话第四条
  // 用例会「绿得没意义」——嵌入根本没被调用也测不出来。这里刻意不给 schedule()，
  // 走的是 embedSingle → store.setEmbedding 那一支，正是导入路径要的那一条。
  // 探针记录（已跑过、不留在文件里）：把这一整套 setEmbedder 摘掉、或把实现里的
  // scheduleEmbed(row) 删掉，下面 lock d 那条用例都会转红——它等的是 embedding 列，
  // 不是「函数被叫过」。
  service.setEmbedder({
    embedSingle: async (t) => { embedded.push(t); return [0, t.length]; },
    embed: async (xs) => xs.map(() => [0, 1])
  });
  const rows = () => store.list({ limit: null, includeArchived: true, includeForgotten: true });
  return { store, service, dir, rows, embedded, writes: () => writes,
    close() { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

test("a foreign pack lands as new rows with the guard's identity", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.pack_id, PACK_ID);
    const row = h.rows().find((m) => m.title === "选 SQLite");
    assert.equal(row.source, IMPORTED_SOURCE);
    assert.equal(row.agent_scope, undefined);
    assert.equal(row.workspace_scope, undefined);
    assert.equal(row.share_pack_id, PACK_ID);
    assert.ok(row.tags.includes(importedTagFor("桉")));
    assert.notEqual(row.created_at, "2026-10-01T00:00:00.000Z", "created_at is the store's, not the pack's");
  } finally { h.close(); }
});

test("re-importing the same pack creates nothing and deletes nothing", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    const before = h.rows().length;
    const again = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(again.created, 0);
    assert.equal(again.skipped_existing, 2);
    assert.equal(h.rows().length, before, "idempotent means nothing removed either");
  } finally { h.close(); }
});

test("a name clash with the host's own memory is reported, never merged into", () => {
  const h = setup();
  try {
    const mine = h.store.save({ type: "decision", title: "选 SQLite", content: "我自己的结论", tags: [] });
    const before = h.store.getById(mine.id);
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(out.created, 1);
    assert.equal(out.title_conflicts.length, 1);
    assert.equal(out.title_conflicts[0].existing_id, mine.id);
    const after = h.store.getById(mine.id);
    assert.equal(after.content, before.content);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.archived, before.archived);
  } finally { h.close(); }
});

test("dry-run answers the same shape and writes nothing", () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), { dryRun: true });
    assert.equal(out.created, 1);
    assert.equal(h.rows().length, 0, "a dry run must leave the library byte-identical");
    const real = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(real.created, 1);
  } finally { h.close(); }
});

test("an invalid pack throws before any row is written", () => {
  const h = setup();
  try {
    const bad = pack([entry("decision", "选 SQLite", "正文 A"), entry("decision", "第二条", "x")]);
    bad.memories[1].external_id = "0000000000000000";
    assert.throws(() => h.service.importSharePack(bad, {}), (e) => e.code === "external-id-mismatch");
    assert.equal(h.rows().length, 0);
  } finally { h.close(); }
});

// 车道 B 的九个池子把外来行报成「不可改写」，收侧的撞名读数得说的是同一件事：
// 撞的是收件人自己的行。上一包的 foreign 行同名不是撞名——它是别人的原文，
// 报出去只会让人去处理一条他既不能改也不能删（C4 之前）的行。
test("a clash is reported against my own row, never against another foreign row", () => {
  const h = setup();
  try {
    const first = h.service.importSharePack(pack([entry("pitfall", "别用表连接", "正文 B")], "桉"), {});
    assert.equal(first.title_conflicts.length, 0, "库里没有同名自己的行时不该凭空报撞名");
    const foreign = h.rows().find((m) => m.title === "别用表连接");
    assert.equal(foreign.source, IMPORTED_SOURCE);
    const second = h.service.importSharePack(pack([entry("pitfall", "别用表连接", "正文 B")], "杉", PACK_ID_2), {});
    assert.equal(second.created, 1, "别的 pack_id 铸出别的幂等键，这一条是真新建");
    assert.deepEqual(second.title_conflicts, [], "上一包的外来行不是「你库里已经有一条」");
  } finally { h.close(); }
});

// 第四条锁（d）。断言的是 embedding **列**：只数 embedSingle 被调了几次的话，
// 一个「调完就把向量丢掉」的实现照样绿，而这条契约要的是对面搜得到这批行。
test("the pack reaches the embed queue and lands a vector after the commit", async () => {
  const h = setup();
  try {
    const out = h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A"), entry("pitfall", "别用表连接", "正文 B")]), {});
    assert.equal(out.created, 2);
    assert.equal(await waitFor(() => h.service.embeddedCount() === 2), true,
      "both imported rows must end up with a vector, not just a scheduled call");
    assert.equal(h.embedded.length, 2, "exactly one embed per imported row");
    // 干跑一条都不许嵌：它一行都没写，排进队列的就是给不存在的行做向量。
    const dry = h.service.importSharePack(pack([entry("constraint", "别动镜像", "正文 C")], "桉"), { dryRun: true });
    assert.equal(dry.created, 1);
    assert.equal(h.embedded.length, 2, "a dry run schedules nothing");
    assert.equal(h.service.embeddedCount(), 2);
  } finally { h.close(); }
});

// 车道 C 预检点名的那条裁定：真导入必须裹在 service.transaction() 里，不是
// store.runAtomically()。两个助手都能让整包原子落库，所以「行在不在」测不出差别，
// 差别在事务那一层的 finally：syncMirror() + notifyWrite()——镜像与写通知才是收件人
// 其余读侧（面板、巩固调度、另一台宿主）看见这批行的地方。换成 runAtomically 会写下
// 整包却一次都不通知；干跑则两次都不该通知（它没改任何东西，却会把空闲计时器顶回去、
// 压掉本来该做的一轮巩固）。
test("the committed batch fires the transaction's write side effects exactly once", () => {
  const h = setup();
  try {
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), { dryRun: true });
    assert.equal(h.writes(), 0, "a dry run must not claim the library just changed");
    h.service.importSharePack(pack([entry("decision", "选 SQLite", "正文 A")]), {});
    assert.equal(h.writes(), 1, "one notifyWrite per committed batch, from transaction()'s finally");
  } finally { h.close(); }
});
