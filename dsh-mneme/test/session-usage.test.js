/**
 * 会话日志使用证据（src/session-usage.js）的回归测试。
 *
 * 本文件锁的重点是**两类「静默少一大截」的坑**（都真踩过）：
 *   ① **zstd 多帧**：`zlib.zstdDecompressSync(buf)` 只解**第一帧**且不报错——实测一个
 *      1.5 MB 的会话文件只解出 291 字节，于是扫描得出「零命中」的假结论。所以这里用
 *      **两帧拼接的夹具**钉死「两帧都要解出来」。
 *   ② **参数在 `arguments` 且是 JSON 字符串**：取 `parameters` 会得到 null，看着像
 *      「调用了但没记参数」。夹具按真实形态写。
 *
 * 另外钉住状态推导的语义边界：`candidate` 是「现存日志里没记录」，不是「从未使用」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

import {
  forEachFrame,
  toolCallsInLine,
  identifyCapability,
  deriveUsageState,
  collectUsage,
  summarizeUsage,
  resolveSessionDir,
  findSessionFiles,
  STALE_AFTER_DAYS
} from "../src/session-usage.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把若干段文本各压成一帧再拼起来，模拟真实的多帧文件。 */
function multiFrameBuffer(chunks) {
  return Buffer.concat(chunks.map((c) => zlib.zstdCompressSync(Buffer.from(c, "utf8"))));
}

/** 造一行真实的 tool-call 记录（参数是 JSON 字符串，不是对象）。 */
function toolCallLine({ name, args, turn = 1, time = 1700000000000 }) {
  const item = { type: "tool-call", id: `call_${Math.random().toString(36).slice(2)}`, name };
  if (args !== undefined) item.arguments = JSON.stringify(args);
  return JSON.stringify({
    type: "assistant/message",
    time,
    data: { turn, step: 1, message: { role: "assistant", content: [item] } }
  });
}

/** 造一个会话目录，内容按给定数组写进一个文件。 */
function makeSessionDir(lines) {
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-"));
  const sessionId = "session-test-0001";
  const dir = join(base, "sessions", `--work-${sessionId.slice(0, 8)}--`, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), multiFrameBuffer(lines), "utf8");
  return { base, dir: join(base, "sessions"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("多帧 zstd：**每一帧**都要解出来（只解第一帧是踩过的坑）", () => {
  const buf = multiFrameBuffer(["第一帧的内容", "第二帧的内容", "第三帧的内容"]);
  const seen = [];
  const stat = forEachFrame(buf, (text) => seen.push(text));
  assert.deepEqual(seen, ["第一帧的内容", "第二帧的内容", "第三帧的内容"], "三帧都要被回调到");
  assert.equal(stat.frames, 3);
  assert.equal(stat.failed, 0);
  // 反证：证明这个夹具真能暴露「只解第一帧」——直接 zstdDecompressSync 只能拿到第一段
  assert.equal(zlib.zstdDecompressSync(buf).toString("utf8"), "第一帧的内容");
});

test("多帧 zstd：每帧都解；截断产生的**半行**由 jsonl 层丢掉（宁可少一条，不要错一条）", () => {
  // 真实的「坏帧」不是帧头损坏，而是**文件正在写**：末帧被截断。
  // 实测结论（写这条时验过）：zstd 是流式格式，截断帧会**解出部分文本而不抛错**，
  // 且 Node 的绑定不暴露「还有多少输入未消费」，所以帧层的完整性判不了。
  // 兜底放在**行层**：半行 JSON 解析失败会被丢弃——代价是少一条记录，收益是绝不误用。
  const good = zlib.zstdCompressSync(Buffer.from("完整帧的内容", "utf8"));

  // 帧层：两帧都要回调到（这是最初踩的坑——只解第一帧）
  const seen = [];
  const stat = forEachFrame(Buffer.concat([good, good]), (t) => seen.push(t));
  assert.equal(stat.frames, 2);
  assert.equal(seen.length, 2);

  // 行层兜底：一个被截断的 tool-call 行不能被当完整记录用
  const fullLine = toolCallLine({ name: "skill", args: { name: "agent-reach" } });
  assert.equal(toolCallsInLine(fullLine).length, 1, "完整行要解析出来");
  const halfLine = fullLine.slice(0, Math.floor(fullLine.length / 2));
  assert.deepEqual(toolCallsInLine(halfLine), [], "半行必须被丢掉，不能猜出一个不完整的调用");

  // 真实截断文件：整帧 + 半帧 → 完整的那些记录照常统计，半行被丢
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-trunc-"));
  try {
    const sessionId = "session-trunc-0001";
    const dir = join(base, "sessions", "work", sessionId);
    mkdirSync(dir, { recursive: true });
    const truncated = zlib.zstdCompressSync(Buffer.from(fullLine, "utf8")).subarray(0, 12);
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.concat([good, truncated]));
    const c = collectUsage({ sessionDir: join(base, "sessions") });
    assert.equal(c.scannedFiles, 1);
    // 好帧里没有 tool-call，截断帧里的调用不完整 → 一条都不该被记
    assert.equal(c.skillCalls, 0, "截断的半行不能被算成一次调用");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("tool-call 解析：参数在 arguments 且是 JSON 字符串", () => {
  // 真实形态：{"type":"tool-call","name":"skill","arguments":"{\"name\":\"agent-reach\"}"}
  const line = toolCallLine({ name: "skill", args: { name: "agent-reach" }, turn: 7, time: 1792000000000 });
  const calls = toolCallsInLine(line);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "skill");
  assert.equal(calls[0].args.name, "agent-reach", "arguments 要二次解析成对象");
  assert.equal(calls[0].turn, 7);
  assert.equal(calls[0].time, 1792000000000);
});

test("tool-call 解析：坏 JSON、非 tool-call 行、参数缺失都要能分清", () => {
  assert.deepEqual(toolCallsInLine("{ 这不是 JSON"), []);
  assert.deepEqual(toolCallsInLine(JSON.stringify({ type: "user/message" })), []);
  // 参数缺失：**调用本身要保留**（它确实发生过），只是 args 为 null
  const noArgs = toolCallLine({ name: "skill" });
  const calls = toolCallsInLine(noArgs);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args, null);
});

test("能力识别：skill 取 arguments.name；MCP 取 mcp__<server>__<tool> 的 server 段", () => {
  assert.deepEqual(identifyCapability({ name: "skill", args: { name: "agent-reach" } }), {
    kind: "skill",
    name: "agent-reach"
  });
  const mcp = identifyCapability({ name: "mcp__github__get_file_contents", args: {} });
  assert.equal(mcp.kind, "mcp");
  assert.equal(mcp.name, "github", "MCP 按 server 聚合（清单里的条目是 server 粒度）");
  assert.equal(mcp.tool, "get_file_contents");
  // 内置工具不是能力清单里的东西 → null（丢掉，不计 unmatched）
  assert.equal(identifyCapability({ name: "read", args: {} }), null);
  assert.equal(identifyCapability({ name: "pwsh", args: {} }), null);
  // skill 没记 name → 返回 name:null，让上层计入 unmatched（如实报，不硬凑）
  assert.deepEqual(identifyCapability({ name: "skill", args: {} }), { kind: "skill", name: null });
  // mcp__ 后面 server 段为空同理
  assert.equal(identifyCapability({ name: "mcp____x", args: {} }).name, null);
});

test("状态推导：没记录=candidate、用过=trusted、久未用=stale", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  assert.equal(deriveUsageState(null, { now }), "candidate");
  assert.equal(deriveUsageState({ uses: 0, lastUsedAt: null }, { now }), "candidate", "0 次也算没记录");
  // 30 天前用过 → trusted
  assert.equal(deriveUsageState({ uses: 3, lastUsedAt: now - 30 * 86400000 }, { now }), "trusted");
  // 超过阈值 → stale
  assert.equal(deriveUsageState({ uses: 3, lastUsedAt: now - (STALE_AFTER_DAYS + 1) * 86400000 }, { now }), "stale");
  // 恰好在阈值上不算 stale（边界）
  assert.equal(deriveUsageState({ uses: 3, lastUsedAt: now - STALE_AFTER_DAYS * 86400000 }, { now }), "trusted");
  // 没有时间戳但有次数 → 不能判 stale，保守给 trusted
  assert.equal(deriveUsageState({ uses: 1, lastUsedAt: null }, { now }), "trusted");
});

test("整条链路：从会话文件聚合出技能与 MCP 计数", () => {
  const ctx = makeSessionDir([
    toolCallLine({ name: "skill", args: { name: "agent-reach" }, turn: 1, time: 1792000000000 }),
    toolCallLine({ name: "mcp__github__get_file_contents", args: {}, turn: 1 }),
    toolCallLine({ name: "skill", args: { name: "agent-reach" }, turn: 2, time: 1792050000000 }),
    toolCallLine({ name: "skill", args: { name: "euthyna" }, turn: 3 }),
    toolCallLine({ name: "read", args: { path: "x" }, turn: 3 }), // 内置，忽略
    toolCallLine({ name: "skill", args: {}, turn: 4 }) // 缺 name → unmatched
  ]);
  try {
    const c = collectUsage({ sessionDir: ctx.dir });
    assert.equal(c.present, true);
    assert.equal(c.scannedFiles, 1);
    assert.equal(c.skillCalls, 3, "两次 agent-reach + 一次 euthyna");
    assert.equal(c.mcpCalls, 1);
    assert.equal(c.unmatched, 1, "缺 name 的那次要对不上，不能静默丢");
    assert.equal(c.skills.get("agent-reach").uses, 2);
    // 最近一次使用要取最大的那个时间戳
    assert.equal(c.skills.get("agent-reach").lastUsedAt, 1792050000000);
    assert.equal(c.mcp.get("github").uses, 1);
  } finally {
    ctx.cleanup();
  }
});

test("降级：会话目录不存在时如实报 present=false，不抛错不编造", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-none-"));
  try {
    const c = collectUsage({ sessionDir: join(base, "no-such-dir") });
    assert.equal(c.present, false);
    assert.equal(c.scannedFiles, 0);
    assert.equal(c.skillCalls, 0);
    assert.deepEqual([...c.skills.keys()], []);
    const s = summarizeUsage(c);
    assert.deepEqual(s.skills, []);
    assert.deepEqual(s.mcp, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("会话目录默认值由 dshHome 推导，不写死本机路径", () => {
  const dir = resolveSessionDir({ dshHome: "/custom/dsh" });
  assert.ok(dir.includes("sessions"), "默认落在 sessions 子目录");
  assert.ok(!/[A-Za-z]:\\Users/i.test(dir), "不得出现本机盘符路径");
  // 环境变量优先
  assert.ok(resolveSessionDir({ dshHome: join(tmpdir(), "x") }).includes("x"));
});

test("文件发现：**所有版本**的会话文件都要收（只认 v4 会漏掉一半历史）", () => {
  // 实测回归：本机同一会话树下并存三种格式——v4（219）、v3（218）、无版本号（72）。
  // 早期版本只认 `session.v4`，静默漏掉 50 次技能调用（euthyna 44 次），
  // 导致三个明明用过的技能被报成 candidate。所以只要求「以 session 开头」。
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-find-"));
  try {
    const sessions = join(base, "sessions");
    mkdirSync(join(sessions, "a", "id1"), { recursive: true });
    mkdirSync(join(sessions, "b", "id2"), { recursive: true });
    writeFileSync(join(sessions, "a", "id1", "session.v4.jsonl.zstd"), multiFrameBuffer(["x"]));
    writeFileSync(join(sessions, "b", "id2", "session.v3.jsonl.zstd"), multiFrameBuffer(["y"]));
    writeFileSync(join(sessions, "b", "id2", "session.jsonl.zstd"), multiFrameBuffer(["z"]));
    writeFileSync(join(sessions, "a", "id1", "other.jsonl"), "不该被收");
    const found = findSessionFiles(sessions);
    assert.equal(found.files.length, 3, "v4 / v3 / 无版本号三种都要找到，other.jsonl 不要");
    assert.equal(found.unreadable.length, 0);
    assert.equal(found.present, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("文件上限可注入，且截断要留痕（CodeRabbit 抓到的静默截断）", () => {
  // 实测回归：早期版本把上限写死在遍历里（MAX_SESSION_FILES=2000），于是
  //   · 调用方传 maxFiles: 5000 也只拿到 2000 个——参数无效，无从察觉；
  //   · 截断发生在内层，外层算不出 truncated（`found.files.length > maxFiles` 永假）。
  // 结果就是「只扫了一部分」却看起来像扫全了——本仓库反复防的那类静默错。
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-cap-"));
  try {
    const sessions = join(base, "sessions");
    // 造 12 个会话文件，限 5 个：应拿到 5 个 + truncated=true
    for (let i = 0; i < 12; i++) {
      const d = join(sessions, `s${String(i).padStart(2, "0")}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "session.v4.jsonl.zstd"), multiFrameBuffer([`line${i}`]));
    }

    // ① limit 真的生效（不是被内层写死的上限压住）
    const capped = findSessionFiles(sessions, { limit: 5 });
    assert.equal(capped.files.length, 5, "limit=5 就该只拿 5 个");
    assert.equal(capped.truncated, true, "被截断必须留痕");

    // ② 不设限时全拿到，且不报截断
    const all = findSessionFiles(sessions);
    assert.equal(all.files.length, 12);
    assert.equal(all.truncated, false, "没截断就不该报截断");

    // ③ collectUsage 透传：maxFiles 生效，且 truncated 透出来
    const c = collectUsage({ sessionDir: sessions, maxFiles: 5 });
    assert.equal(c.scannedFiles, 5);
    assert.equal(c.truncated, true, "collectUsage 要把截断标记透出来");
    assert.equal(c.totalFiles, 5, "totalFiles 是被限制后的数量（不是磁盘总数）");

    // ④ 给足够大的 maxFiles 时能扫全（旧实现这里会失败：内层卡 2000）
    const c2 = collectUsage({ sessionDir: sessions, maxFiles: 9999 });
    assert.equal(c2.scannedFiles, 12);
    assert.equal(c2.truncated, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("目录不可读要与「空目录」**可分辨**（不许同形）", () => {
  // 实测回归：早期版本用 existsSync 定 present、readdirSync 失败直接 return，
  // 于是 ACL 拒绝的目录产出与「可读空目录」逐字段相同的读数
  // （present=true, scannedFiles=0, unreadable=[]），清单侧 175 条全 candidate。
  // 这正是本仓库反复防的那类错：读不到被显示成「读到但没有」。
  const base = mkdtempSync(join(tmpdir(), "mneme-usage-unreadable-"));
  try {
    // ① 不存在的目录：present=false
    const missing = findSessionFiles(join(base, "nope"));
    assert.equal(missing.present, false);
    assert.equal(missing.files.length, 0);

    // ② 存在的空目录：present=true、无 unreadable
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    const emptyRes = findSessionFiles(empty);
    assert.equal(emptyRes.present, true);
    assert.equal(emptyRes.files.length, 0);
    assert.equal(emptyRes.unreadable.length, 0, "空目录不该有 unreadable");

    // ③ 悬空符号链接：present=true，但**必须有 unreadable**，与空目录不同形
    try {
      symlinkSync(join(base, "no-such-target"), join(empty, "session.dangling.jsonl.zstd"), "junction");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") return; // 无权限则跳过本断言
      throw error;
    }
    const dangling = findSessionFiles(empty);
    assert.ok(dangling.unreadable.length > 0, "读不到的项必须留痕，否则与空目录同形");
    // 而且上层能区分：collectUsage 的 readable 会变 false
    const c = collectUsage({ sessionDir: empty });
    assert.equal(c.present, true);
    assert.equal(c.readable, false, "有读不动的项时 readable 必须为 false");
    assert.ok(c.unreadable.length > 0, "unreadable 要透到 collectUsage");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
