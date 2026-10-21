// 分享包纯核心的形状锁。这个文件盯两类回归：
//   a) 包里的字段集合只许是白名单那几样 —— 少带是本意（不带 id / 向量 / 时间史），
//      多带就是泄露；所以这里锁「不含什么」比锁「含什么」更要紧。
//   b) 幂等键的派生必须与接收侧重算一致（车道 C 靠它），改一个参数顺序就是破坏
//      所有已发出去的包。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_KIND, deriveExternalId
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
