import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionRecorder, projectRootOf, MAX_BUFFERED_EVENTS } from "../src/pipeline-runner.js";
import { validatePipeline } from "../src/pipeline.js";

// 这组测试守的是串联层：把「事件 → 观察 → 归属 → 窗口 → 落盘」串起来的那一层。
// 它最要紧的两条性质：
//   ① 没开窗时**一个字都不记**（漏记可接受，编造不可）
//   ② 热路径上**永不抛**（宿主的一步不许被插件的可选能力带崩）

const PIPE = validatePipeline({
  id: "demo",
  name: "演示",
  project: "a/b",
  version: 0,
  status: "active",
  done: "走完",
  trigger: [{ kind: "phrase", value: "走一遍" }],
  steps: [
    { id: "P6", phase: "准备", title: "跑测试", when: "改完", do: "npm test", who: "main", tool: "npm test", done: "全绿", risk: "R0", needs: [], why: "因为" }
  ]
}, "demo.json");

/** 造一个假的 ctx：只实现 on()，并记下 listener 供测试手动触发。 */
function fakeCtx() {
  let listener = null;
  return {
    ctx: {
      on(event, fn) {
        if (event === "session/event") listener = fn;
        return () => { listener = null; };
      }
    },
    emit(session, event) { if (listener) listener(session, event); },
    hasListener: () => listener !== null
  };
}

function clockFrom(startMs) {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

function callAndResult(command, ok = true, callId = "c1") {
  return [
    { type: "tool/call", data: { callId, name: "pwsh", arguments: JSON.stringify({ command }) } },
    { type: "tool/result", data: { callId, message: { isError: ok === false } } }
  ];
}

test("没开窗时一个字都不记：事件到了也不缓冲（这是整个设计的地基）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  for (const e of callAndResult("npm test")) f.emit(session, e);
  assert.deepEqual(rec.status({ session }), { open: false }, "没开窗就该没有窗口");
  assert.equal(rec.stop({ session }).reason, "no-open-window");
});

test("开窗 → 走一遍 → 结账：产出并落盘一条账", () => {
  const f = fakeCtx();
  let written = null;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: (root, id, run) => { written = { root, id, run }; },
    now: clockFrom(Date.UTC(2026, 9, 16, 12, 0, 0))
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  const started = rec.start({ session, pipelineId: "demo" });
  assert.equal(started.ok, true);
  assert.equal(started.steps, 1);

  for (const e of callAndResult("npm test")) f.emit(session, e);
  const stopped = rec.stop({ session });

  assert.equal(stopped.ok, true);
  assert.equal(stopped.steps, 1);
  assert.equal(stopped.observations, 1);
  assert.equal(written.id, "demo");
  assert.equal(written.root, "C:\\proj");
  assert.deepEqual(written.run.steps.map((s) => s.id), ["P6"]);
});

test("同会话重复开窗被拒，不顶掉前一个（顶掉会让前一次执行悄无声息地消失）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  assert.equal(rec.start({ session, pipelineId: "demo" }).ok, true);
  const second = rec.start({ session, pipelineId: "demo" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-open");
});

test("不同会话各开各的窗口，互不干扰", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const a = { id: "sa", header: { cwd: "C:\\proj" } };
  const b = { id: "sb", header: { cwd: "C:\\proj" } };

  rec.start({ session: a, pipelineId: "demo" });
  rec.start({ session: b, pipelineId: "demo" });
  for (const e of callAndResult("npm test")) f.emit(a, e);

  // 事件是**缓冲到 stop 才配对**的（结果可能比调用晚很久），所以开着窗时
  // observations 本来就是 0——这里该验的是缓冲隔离，不是计数。
  assert.equal(rec.status({ session: a }).bufferedEvents, 2, "a 的事件只进 a 的窗口");
  assert.equal(rec.status({ session: b }).bufferedEvents, 0, "b 一条都不该收到");
});

test("找不到工作流时说清是「没有」还是「读不出来」，并给可用清单", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => null, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };

  const missing = rec.start({ session, pipelineId: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "pipeline-not-found");

  const f2 = fakeCtx();
  const rec2 = createExecutionRecorder({
    ctx: f2.ctx,
    resolvePipeline: () => { throw new Error("坏 JSON"); },
    persistRun: () => {}
  });
  const broken = rec2.start({ session: { id: "s2", header: { cwd: "C:\\proj" } }, pipelineId: "demo" });
  assert.equal(broken.reason, "pipeline-unreadable", "读不出来与没有这条是两件事");
  assert.match(broken.detail, /坏 JSON/);
});

test("拿不到会话工作目录时拒开，而不是硬塞一个别处的项目", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const noCwd = { id: "s1", header: {} };
  assert.equal(rec.start({ session: noCwd, pipelineId: "demo" }).reason, "no-project-root");
  // 没有 session 也一样
  assert.equal(rec.start({ pipelineId: "demo" }).reason, "no-session");
});

test("一条观察都没认出来：不写空账，reason 说清是「没观察」", () => {
  const f = fakeCtx();
  let wrote = false;
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => { wrote = true; }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  // 只有无关工具调用：认不出命令执行器，配不出观察
  f.emit(session, { type: "tool/call", data: { callId: "x", name: "read", arguments: '{"file_path":"a.md"}' } });
  const stopped = rec.stop({ session });

  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "no-observations");
  assert.equal(wrote, false, "不写空账假装成功");
});

test("写盘失败：如实回报，且窗口已摘掉（不留半死窗口挂在那儿）", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => { throw new Error("磁盘满"); }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  for (const e of callAndResult("npm test")) f.emit(session, e);

  const stopped = rec.stop({ session });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "write-failed");
  assert.match(stopped.detail, /磁盘满/);
  assert.equal(rec.status({ session }).open, false, "窗口必须已摘掉");
});

test("热路径永不抛：listener 内部出错不冒泡到宿主的一步", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => {},
    logger: { warn() {} }
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  // 各种畸形事件都不该抛
  for (const bad of [null, undefined, {}, { type: "tool/call" }, { type: "tool/call", data: null }]) {
    f.emit(session, bad);
  }
  assert.equal(true, true, "走到这里没抛就算过");
});

test("缓冲封顶：忘了 stop 时标记 truncated，而不是无限吃内存", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({
    ctx: f.ctx,
    resolvePipeline: () => PIPE,
    persistRun: () => {},
    maxBufferedEvents: 3
  });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });

  for (let i = 0; i < 5; i += 1) {
    f.emit(session, { type: "tool/call", data: { callId: `c${i}`, name: "pwsh", arguments: '{"command":"npm test"}' } });
  }
  const s = rec.status({ session });
  assert.equal(s.truncated, true);
  assert.equal(s.bufferedEvents, 3);
});

test("dispose 摘掉监听，之后的窗口全清", () => {
  const f = fakeCtx();
  const rec = createExecutionRecorder({ ctx: f.ctx, resolvePipeline: () => PIPE, persistRun: () => {} });
  const session = { id: "s1", header: { cwd: "C:\\proj" } };
  rec.start({ session, pipelineId: "demo" });
  assert.equal(f.hasListener(), true);

  rec.dispose();
  assert.equal(f.hasListener(), false);
  assert.equal(rec.status({ session }).open, false);
  rec.dispose(); // 重复 dispose 不报错
});

test("projectRootOf 与 scope.js 同口径：header 优先，不在时退回请求头", () => {
  assert.equal(projectRootOf({ header: { cwd: "C:\\a" } }), "C:\\a");
  assert.equal(projectRootOf({ requestHeader: () => ({ config: { cwd: "C:\\b" } }) }), "C:\\b");
  assert.equal(projectRootOf({ header: {} }), null);
  assert.equal(projectRootOf(null), null);
});

test("缓冲上限常量存在且是个正整数", () => {
  assert.equal(Number.isInteger(MAX_BUFFERED_EVENTS), true);
  assert.ok(MAX_BUFFERED_EVENTS > 0);
});
