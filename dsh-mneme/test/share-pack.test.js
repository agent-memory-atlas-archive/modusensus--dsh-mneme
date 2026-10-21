// 分享包纯核心的形状锁。这个文件盯五类回归：
//   a) 进包的字段集合只许是白名单那几样 —— 少带是本意（不带 id / 向量 / 热度 / 本机
//      scope），多带就是泄露；所以这里锁「不含什么」比锁「含什么」更要紧。row 侧与
//      pack 侧各钉一条：白名单是逐层收窄的，只锁一层就有一层可以顺手放宽。
//   b) 幂等键的派生必须与接收侧重算一致（车道 C 靠它），改一个参数顺序就是破坏
//      所有已发出去的包。
//   c) 取行口径：哪些行不进包、以什么原因不进（跳过清单的读数就靠这些字面量），以及
//      不进的那几条返回的 title 也已经是遮过 home 的 —— 清单会进包体、会上终端。
//   d) 分享边界用的是未门控的文本扫描面 —— 换成 config 门控的那个工厂，用户没开
//      写入闸门就等于裸发整库（静态锁，见最后一条用例）。
//   e) 打包口径逐条钉死：水位量的是**最终序列化字节**（不是条数也不是字符数——中文差
//      三倍，按字符数判等于把 413 留给对面）；skip_list 截断后计数仍须是全量（截的是
//      清单不是账）；filters 是分享者的显式收窄，既不进跳过计数也不进清单（进了就说谎：
//      她没跳过，是她自己选的），且形状读不懂的 filters 只许当收窄、不许当放行（那侧
//      错的方向是把整库发出去）；alias 缺省恒为空串，绝不拿本机身份猜一个填上——那是
//      这份格式里唯一一处会替人自报家的字段。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARE_KIND, deriveExternalId, createHomeRedactor, classifyRowForShare, buildSharePack
} from "../src/share.js";

test("pack kind is the versioned literal the receiver keys on", () => {
  assert.equal(SHARE_KIND, "mneme.share/v1");
});

test("external_id is 16 hex chars and stable per (pack, type, title)", () => {
  const a = deriveExternalId("abcdef0123456789", "decision", "选 SQLite");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, deriveExternalId("abcdef0123456789", "decision", "选 SQLite"));
});

test("external_id separates fields with NUL so concatenation cannot collide", () => {
  // 无分隔拼接时 ("ab","c") 与 ("a","bc") 同键 —— 这类碰撞在幂等表上就是静默串号。
  assert.notEqual(deriveExternalId("p", "ab", "c"), deriveExternalId("p", "a", "bc"));
  assert.notEqual(deriveExternalId("p1", "t", "x"), deriveExternalId("p2", "t", "x"));
});

test("external_id strips NUL out of the fields themselves", () => {
  // 分隔符只保证「字段之间」的切法唯一；字段自己含 U+0000 时切点又回到字节手里，
  // ("t","a\\0b") 与 ("t\\0a","b") 拼出同一串。接收侧（车道 C）按包内字节重算的就是
  // 这一串，所以两个键相等的后果是「这条已被吃过」——该建的行静默不建。
  // 归一放在 deriveExternalId 内部而不是调用方：铸造与重算必须共用一个口径。
  assert.notEqual(deriveExternalId("p", "t", "a\u0000b"), deriveExternalId("p", "t\u0000a", "b"));
  assert.notEqual(deriveExternalId("p\u0000a", "t", "x"), deriveExternalId("p", "a\u0000t", "x"));
  // 剥的只有 U+0000：trim 的空白口径不许跟着变，否则已发出去的键会全体漂移。
  assert.equal(deriveExternalId("p", "t", " x "), deriveExternalId("p", "t", "x"));
});

const row = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", type: "decision", title: "t", content: "c",
  tags: [], importance: 3, archived: 0, forgotten: 0, source: "session",
  agent_scope: null, workspace_scope: null, created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z", ...over
});

test("home redaction covers both separators and is case-insensitive", () => {
  const home = "/fake/home/alex";
  const redact = createHomeRedactor(home);
  assert.equal(redact(`read ${home}/docs/a.md`), "read ~/docs/a.md");
  assert.equal(redact(`read ${home.split("/").join("\\")}\\docs\\a.md`), "read ~/docs\\a.md");
  assert.equal(redact(`read ${home.toUpperCase()}/x`), "read ~/x");
  assert.equal(redact("nothing here"), "nothing here");
});

test("a windows homedir is redacted however the body spells it", () => {
  // homedir() 在 Windows 上给反斜杠，正文里同一目录却常被写成斜杠（Node 两边都收，
  // 模型输出的路径两种都有）。只按 base 的方向匹配 = 另一半原样进包，泄露的是用户名。
  const redact = createHomeRedactor("C:\\Users\\alex");
  assert.equal(redact("read C:\\Users\\alex\\docs\\a.md"), "read ~/docs\\a.md");
  assert.equal(redact("read C:/Users/alex/docs/a.md"), "read ~/docs/a.md");
  assert.equal(redact("home is c:/USERS/Alex"), "home is ~");
  // 已知取舍：前缀没有名字边界，所以 `/Users/alex` 会把邻居目录 `/Users/alexandra`
  // 一起吃掉。这一侧错的方向是**多遮**（永远不泄露），另一侧错的方向才是泄露，
  // 所以这里不加边界。真要加，改的是这一行——别顺手改成静默行为。
  assert.equal(redact("C:/Users/alexandra/x"), "~andra/x");
});

test("the JSON-escaped spelling of a windows home is redacted too", () => {
  // 正文里用 JSON 或引号包一段 Windows 路径时，落库的字节是双反斜杠（`C:\\Users\\alex`）。
  // 它既不是 base 也不是那两个单分隔符形态，两边都不匹配 —— 于是用户名原样进包，而
  // 这份包的设计前提正是不含它。漏的这一类跟「只补一个方向」是同一类错：判据按一种
  // 拼法写，现实里同一目录有三种拼法。
  const redact = createHomeRedactor("C:\\Users\\alex");
  assert.equal(redact('{"path": "C:\\\\Users\\\\alex\\\\notes.md"}'), '{"path": "~/\\notes.md"}');
  assert.equal(redact("read C:\\\\Users\\\\alex"), "read ~");
  // 已知取舍（同上条）：折掉的仍是「前缀 + 紧跟的一个分隔符」，多出来那个反斜杠按原样
  // 留着——不改写用户写下的其余字节。这一条锁的是「不泄露」，不是「输出好看」。
  assert.ok(!redact("C:\\\\Users\\\\alex\\\\secrets").includes("alex"), "escaped home prefix leaked");
  // 泄露的是进包的那条路径，所以在进包口径上也钉一次：同一个 redact，不补第二刀。
  const shipped = classifyRowForShare(row({ content: '{"p": "C:\\\\Users\\\\alex\\\\a.md"}' }), { redact });
  assert.equal(shipped.include, true);
  assert.ok(!JSON.stringify(shipped.row).includes("alex"), "escaped home prefix shipped in the pack");
});

test("the redactor matches separator runs, so no escaping depth survives", () => {
  // 按固定拼法打补丁是隐私函数的错法：同一目录在正文里有的是字节写法（单反斜杠、JSON
  // 转义、混合、二次编码），漏一种就漏用户名，而「补到哪一种」永远追着现实跑。判据
  // 换成段间游程（至少一个分隔符、个数不限）之后，转义层数不再是判据，一整类一起关掉。
  const redact = createHomeRedactor("C:\\Users\\alex");
  const bs = (n) => "\\".repeat(n);
  for (const n of [1, 2, 3, 4, 8]) {
    assert.ok(
      !redact(`read C:${bs(n)}Users${bs(n)}alex${bs(n)}notes.md`).includes("alex"),
      `home leaked at ${n} separators per join`
    );
  }
  // 混合（前一处两个、后一处一个）与二次编码是手写 JSON 时最容易落库的两种，也是上一版
  // 「三个固定形态」恰好都够不着的那两种。
  assert.ok(!redact(`read C:${bs(2)}Users${bs(1)}alex${bs(2)}a.md`).includes("alex"), "home leaked through mixed escaping");
  assert.ok(!redact(`{"p": "C:${bs(4)}Users${bs(2)}alex${bs(3)}x"}`).includes("alex"), "home leaked through doubly-encoded escaping");
  // 前缀带尾分隔符时（`homedir()` 一般不给，但配置里写出来的人不少）：尾那个不许变成
  // 「必须存在」的条件，否则正文里没写尾斜杠的那条照常漏。
  assert.ok(!createHomeRedactor("C:\\Users\\alex\\")("home C:\\Users\\alex\\p").includes("alex"), "trailing-separator home leaked");
  // 已知取舍：游程要求段间**至少一个**分隔符，所以 `C:Users` 这种无分隔写法不命中。
  // 那不是同一目录的另一种拼法（Node 与 JSON 都不产它），要命中只能拆掉前缀的全部约束，
  // 而这一侧错的方向是泄露。锁在这里，免得日后当 bug 顺手加回来。
  assert.equal(redact("C:Usersalex is not a path"), "C:Usersalex is not a path");
});

test("an empty or weird homedir never turns content into mangled text", () => {
  const redact = createHomeRedactor("");
  assert.equal(redact("keep this"), "keep this");
  // 全是分隔符的 home（`//`）若照原样进游程，拼出来的正则会把正文里的斜杠都吃成 `~/`。
  assert.equal(createHomeRedactor("//")("a // b"), "a // b");
});

test("archived, forgotten and out-of-scope types are skipped with a reason", () => {
  assert.equal(classifyRowForShare(row({ archived: 1 }), {}).reason, "archived");
  assert.equal(classifyRowForShare(row({ forgotten: 1 }), {}).reason, "forgotten");
  assert.equal(classifyRowForShare(row({ type: "document" }), {}).reason, "readonly_type");
  assert.equal(classifyRowForShare(row({ type: "summary" }), {}).reason, "excluded_type");
  assert.equal(classifyRowForShare(row(), {}).include, true);
});

test("a skipped row's title comes back redacted, from here", () => {
  // 跳过清单不是「只在本地看」的：A3 把 verdict.title 原样写进 pack.report.skip_list，
  // A7 又把这份清单打到终端。一条标题里带本机 home 前缀的记忆只要不进包，未脱敏的
  // title 就把用户名装进了那份「设计上不含它」的文件。所以在源头遮，消费方才不必
  // 各自补第二刀（也才没有「忘了补」这一类回归可犯）。
  const redact = createHomeRedactor("/fake/home/alex");
  const leanOn = (over) => classifyRowForShare(row({ title: "/fake/home/alex/退路方案", ...over }), { redact });
  for (const [over, reason] of [
    [{ archived: 1 }, "archived"],
    [{ forgotten: 1 }, "forgotten"],
    [{ type: "document" }, "readonly_type"],
    [{ type: "summary" }, "excluded_type"],
    // sensitive 这一级扫的是未脱敏原文（先扫再遮），遮完的标题仍要安全。
    [{ content: "key sk-abcdefghijklmnopqrstuvwxyz012345" }, "sensitive"]
  ]) {
    const verdict = leanOn(over);
    assert.equal(verdict.reason, reason);
    assert.equal(verdict.title, "~/退路方案");
    assert.ok(!verdict.title.includes("alex"), "leaked home prefix in skip title");
  }
});

test("a credential in the body drops the whole row instead of redacting it", () => {
  // 就地打码会造出一条读不通的半截记忆；整条不进 + 跳过清单里看得见标题，才是
  // 分享者能复核的形态（spec §4）。
  const hit = classifyRowForShare(row({ content: "key sk-abcdefghijklmnopqrstuvwxyz012345" }), {});
  assert.equal(hit.include, false);
  assert.equal(hit.reason, "sensitive");
});

test("a blank memory is skipped as blank_or_noise before the sensitive check", () => {
  // 空白/噪声的唯一判据是 informationlessReason（src/write-admission.js:117），它按
  // title+content 的**组合**口径判：两侧归一后都不剩字才算命中（"blank" 全空、
  // "noise" 只剩标点）。share 不另写一套空白判定 —— 判据只许有一份。
  assert.equal(classifyRowForShare(row({ title: "", content: "" }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "", content: "   " }), {}).reason, "blank_or_noise");
  assert.equal(classifyRowForShare(row({ title: "...", content: "---" }), {}).reason, "blank_or_noise");
  // 组合口径的另一面：标题还有字、正文一片空白的那条**不算**信息缺失，照常进包。
  assert.equal(classifyRowForShare(row({ content: "   " }), {}).include, true);
  // 顺序锁（空白先于敏感）：判据只看 title/content，扫描面却含 tags，所以一条正文
  // 为空、标签里带凭据的记忆两条都命中。报 blank_or_noise 才是对的原因 —— 没有正文
  // 就没有可泄露的东西，记成 sensitive 会让跳过清单的读数把用户指向错的那一类。
  assert.equal(
    classifyRowForShare(row({ title: "", content: "", tags: ["sk-abcdefghijklmnopqrstuvwxyz012345"] }), {}).reason,
    "blank_or_noise"
  );
});

test("the row that enters the pack carries only the whitelisted fields", () => {
  // 锁「不含什么」：id / 向量 / 热度 / source / 本机 scope 一律不带。agent_scope 与
  // workspace_scope 是本机目录与项目名，跟着包走就是泄露；对面入库时会按自己的
  // 口径重算这些，带过去只会被当成真相源。
  const out = classifyRowForShare(row({
    agent_scope: "secret-project",
    workspace_scope: "C:\\Users\\alex\\work",
    embedding: [0.1, 0.2],
    heat: 9.5,
    access_count: 42,
    content_hash: "deadbeef"
  }), {});
  assert.equal(out.include, true);
  assert.deepEqual(Object.keys(out.row).sort(), [
    "content", "content_hash", "created_at", "epistemic_status", "importance",
    "tags", "title", "type", "updated_at"
  ]);
  assert.equal(out.row.content_hash, "deadbeef");
});

const packInput = (rows, over = {}) => buildSharePack({
  rows, alias: "桉桉", homeDir: "/fake/home/alex", packageVersion: "0.9.4",
  packId: "abcdef0123456789", generatedAt: "2026-10-22T00:00:00.000Z", ...over
});

test("pack carries the whitelist and nothing else", () => {
  const { pack } = packInput([row({ embedding: "huge", content_history: "[{}]", doc_path: "/x", agent_scope: "/fake/home/alex/p" })]);
  assert.equal(pack.kind, "mneme.share/v1");
  assert.equal(pack.memories.length, 1);
  const m = pack.memories[0];
  for (const banned of ["id", "embedding", "content_history", "doc_path", "agent_scope", "workspace_scope", "sensitivity", "_full_content", "evidence"]) {
    assert.ok(!(banned in m), `pack must not carry ${banned}`);
  }
  assert.equal(m.type, "decision");
  assert.match(m.external_id, /^[0-9a-f]{16}$/);
});

test("report counts every skip reason and caps the list it shows", () => {
  const rows = [
    row({ type: "decision", title: "keep" }),
    row({ type: "preference", archived: 1 }),
    row({ type: "history", forgotten: 1 }),
    row({ type: "document" }),
    row({ type: "summary" }),
    // 空白这一条要标题也没字：informationlessReason 是 title+content 的**组合**口径
    // （上面 A2 那条用例锁过「标题有字、正文空白照常进包」），只空正文的话这一格永远是 0。
    row({ type: "pattern", title: "", content: "   " })
  ];
  const { pack } = packInput(rows);
  assert.equal(pack.report.included, 1);
  assert.deepEqual(pack.report.skipped, {
    archived: 1, forgotten: 1, readonly_type: 1, excluded_type: 1, blank_or_noise: 1, sensitive: 0
  });
  assert.ok(pack.report.skip_list.every((s) => typeof s.title === "string" && typeof s.reason === "string"));
});

test("skip list truncates but the counters stay exact", () => {
  const rows = Array.from({ length: 80 }, (_, i) => row({ type: "history", archived: 1, title: `a${i}` }));
  const { pack } = packInput(rows);
  assert.equal(pack.report.skipped.archived, 80);
  assert.equal(pack.report.skip_list.length, 50);
});

test("a pack over the water mark is refused with the measured size", () => {
  const rows = [row({ content: "字".repeat(2_000_000) })];
  const out = packInput(rows);
  assert.equal(out.ok, false);
  assert.equal(out.error, "too-large");
  assert.ok(out.bytes > out.limitBytes);
});

test("filters narrow what goes in without touching the reason counters", () => {
  const rows = [row({ type: "decision", title: "a" }), row({ type: "preference", title: "b" })];
  const byType = packInput(rows, { filters: { type: ["decision"] } });
  assert.equal(byType.pack.report.included, 1);
  assert.equal(byType.pack.memories[0].title, "a");
  const byTag = packInput([row({ type: "decision", title: "a", tags: ["keep"] })], { filters: { tag: "keep" } });
  assert.equal(byTag.pack.memories[0].tags.includes("keep"), true);
  const byTagMiss = packInput([row({ type: "decision", title: "a", tags: ["other"] })], { filters: { tag: "keep" } });
  assert.equal(byTagMiss.pack.report.included, 0);
});

test("a filter shape this function can't read never widens to the whole library", () => {
  // 出口把 `--type` 传成数组还是裸字符串不由这里决定（CLI 一个旗标给字符串、面板多选给
  // 数组都说得通）。能决定的是：读得懂的收窄意图不许因为形状不对就当「没筛」——那侧
  // 错的方向是**多发**，分享者以为只发了一类，实际把整库发了出去。
  const rows = [row({ type: "decision", title: "a" }), row({ type: "preference", title: "b" })];
  const byString = packInput(rows, { filters: { type: "decision" } });
  assert.equal(byString.pack.report.included, 1);
  assert.equal(byString.pack.memories[0].type, "decision");
  // 反过来，「填了但只剩空白」是**没填**，与空数组同口径：读成筛成空包才是说谎。
  assert.equal(packInput(rows, { filters: { type: "  ", tag: "" } }).pack.report.included, 2);
  assert.equal(packInput(rows, { filters: { type: [], tag: "   " } }).pack.report.included, 2);
});

test("alias defaults to the neutral label, never to a guessed identity", () => {
  const out = buildSharePack({ rows: [row()], homeDir: "/fake/home/alex", packageVersion: "0.9.4", packId: "p", generatedAt: "2026-10-22T00:00:00.000Z" });
  assert.equal(out.pack.alias, "");
});

test("the share filter uses the ungated scanner, never the gated factory", () => {
  // spec §4：分享边界本身就是安全边界。`createSensitiveScan({config})` 在
  // `sensitiveScanEnabled` 关时返回 null（`src/sensitive-scan.js:199`），谁要是把
  // 这里「顺手统一」成工厂，用户没开写入闸门就等于裸发整库。
  const text = readFileSync(new URL("../src/share.js", import.meta.url), "utf8");
  assert.ok(text.includes("scanSensitive("), "share must scan with the ungated text scanner");
  assert.ok(!text.includes("createSensitiveScan"), "share must not route through the gated factory");
});
