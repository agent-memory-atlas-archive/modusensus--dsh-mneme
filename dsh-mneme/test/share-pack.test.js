// 分享包纯核心的形状锁。这个文件盯四类回归：
//   a) 进包的字段集合只许是白名单那几样 —— 少带是本意（不带 id / 向量 / 热度 / 本机
//      scope），多带就是泄露；所以这里锁「不含什么」比锁「含什么」更要紧。
//   b) 幂等键的派生必须与接收侧重算一致（车道 C 靠它），改一个参数顺序就是破坏
//      所有已发出去的包。
//   c) 取行口径：哪些行不进包、以什么原因不进（跳过清单的读数就靠这些字面量）。
//   d) 分享边界用的是未门控的文本扫描面 —— 换成 config 门控的那个工厂，用户没开
//      写入闸门就等于裸发整库（静态锁，见最后一条用例）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARE_KIND, deriveExternalId, createHomeRedactor, classifyRowForShare
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

test("an empty or weird homedir never turns content into mangled text", () => {
  const redact = createHomeRedactor("");
  assert.equal(redact("keep this"), "keep this");
});

test("archived, forgotten and out-of-scope types are skipped with a reason", () => {
  assert.equal(classifyRowForShare(row({ archived: 1 }), {}).reason, "archived");
  assert.equal(classifyRowForShare(row({ forgotten: 1 }), {}).reason, "forgotten");
  assert.equal(classifyRowForShare(row({ type: "document" }), {}).reason, "readonly_type");
  assert.equal(classifyRowForShare(row({ type: "summary" }), {}).reason, "excluded_type");
  assert.equal(classifyRowForShare(row(), {}).include, true);
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

test("the share filter uses the ungated scanner, never the gated factory", () => {
  // spec §4：分享边界本身就是安全边界。`createSensitiveScan({config})` 在
  // `sensitiveScanEnabled` 关时返回 null（`src/sensitive-scan.js:199`），谁要是把
  // 这里「顺手统一」成工厂，用户没开写入闸门就等于裸发整库。
  const text = readFileSync(new URL("../src/share.js", import.meta.url), "utf8");
  assert.ok(text.includes("scanSensitive("), "share must scan with the ungated text scanner");
  assert.ok(!text.includes("createSensitiveScan"), "share must not route through the gated factory");
});
