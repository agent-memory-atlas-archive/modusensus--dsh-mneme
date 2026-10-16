import test from "node:test";
import assert from "node:assert/strict";
import { parseMoRunInput, createMoRunHandler, registerMoRunCommand, MO_RUN_COMMAND } from "../src/pipeline-command.js";

// 这组测试守的是 `/mo-run` 的回执质量。命令回执是这个功能**唯一的对外窗口**
// （面板侧还没做），所以最要紧的性质是：**失败必须说清是哪种失败**，
// 尤其「一条观察都没认出来」绝不能被含糊成「完成」。

test("解析：三种子命令 + 默认看状态 + 不认识的词给用法", () => {
  assert.deepEqual(parseMoRunInput("start dsh-mneme-release"), { action: "start", pipelineId: "dsh-mneme-release" });
  assert.deepEqual(parseMoRunInput("stop"), { action: "stop" });
  assert.deepEqual(parseMoRunInput("status"), { action: "status" });
  // 不带参数 = 看状态：最安全的默认，不会误开窗
  assert.deepEqual(parseMoRunInput(""), { action: "status" });
  assert.deepEqual(parseMoRunInput("   "), { action: "status" });
  assert.deepEqual(parseMoRunInput(null), { action: "status" });
  assert.equal(parseMoRunInput("whatever").action, "help");
  // 大小写不敏感，id 里带空格也能取全
  assert.deepEqual(parseMoRunInput("START a b"), { action: "start", pipelineId: "a b" });
});

/** 造一个受控的假记录器，回执里只看它返回的东西怎么被翻译。 */
function fakeRecorder({ start, stop, status } = {}) {
  return {
    start: start ?? (() => ({ ok: true, pipelineId: "demo", steps: 3 })),
    stop: stop ?? (() => ({ ok: true, pipelineId: "demo", steps: 2 })),
    status: status ?? (() => ({ open: false }))
  };
}

const invocation = (rawInput) => ({ rawInput, agent: { session: { id: "s1" } } });

test("start 成功：说清开了哪条、几步", () => {
  const h = createMoRunHandler({ recorder: fakeRecorder(), language: () => "zh" });
  const r = h(invocation("start demo"));
  assert.equal(r.kind, "success");
  assert.match(r.text, /已开窗/);
  assert.match(r.text, /demo/);
  assert.match(r.text, /3 步/);
});

test("start 已开着窗口：给的是「先 stop」，而不是静默顶掉", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "already-open", pipelineId: "old" }) }),
    language: () => "zh"
  });
  const r = h(invocation("start demo"));
  assert.match(r.text, /already|已经开着|旧|old|先/);
});

test("start 找不到工作流：把可用清单给出来（别让人猜）", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-not-found", available: ["a", "b"] }) }),
    language: () => "zh"
  });
  const r = h(invocation("start nope"));
  assert.match(r.text, /a/);
  assert.match(r.text, /b/);
});

test("start 读不出来与没有这条是两种话——不许合并成同一句", () => {
  const unreadable = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-unreadable", detail: "坏 JSON" }) }),
    language: () => "zh"
  });
  const notFound = createMoRunHandler({
    recorder: fakeRecorder({ start: () => ({ ok: false, reason: "pipeline-not-found", available: [] }) }),
    language: () => "zh"
  });
  assert.notEqual(unreadable(invocation("start demo")).text, notFound(invocation("start demo")).text);
  assert.match(unreadable(invocation("start demo")).text, /坏 JSON/);
});

test("stop 成功：报步数，并把「没观察到」与「认不出」「歧义」「非命令」分开说", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({
      stop: () => ({
        ok: true, pipelineId: "demo", steps: 2,
        unobserved: ["A3"], unattributed: 1, ambiguous: 2, notCommands: 5, truncated: false
      })
    }),
    language: () => "zh"
  });
  const r = h(invocation("stop"));
  assert.match(r.text, /落盘/);
  assert.match(r.text, /2 步/);
  assert.match(r.text, /A3/, "没观察到的步骤要点名");
  assert.match(r.text, /1 次动作认不出/);
  assert.match(r.text, /2 次动作有多个候选/);
  assert.match(r.text, /5 次调用不是命令执行器/);
});

test("stop 的关键一条：一条观察都没认出来时，明说没落盘，不许含糊成完成", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "no-observations", bufferedEvents: 12, notCommands: 12 }) }),
    language: () => "zh"
  });
  const r = h(invocation("stop"));
  assert.match(r.text, /没有落盘/, "必须明确说没写账");
  assert.match(r.text, /12/, "要把缓冲条数与其中非命令的条数给出来，便于判断是通道问题还是用法问题");
});

test("stop 没有开着窗口 / 写盘失败：各自说清，不混为一谈", () => {
  const none = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "no-open-window" }) }),
    language: () => "zh"
  });
  const failed = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "write-failed", detail: "磁盘满" }) }),
    language: () => "zh"
  });
  assert.match(none(invocation("stop")).text, /没有开着窗口/);
  assert.match(failed(invocation("stop")).text, /磁盘满/);
  assert.notEqual(none(invocation("stop")).text, failed(invocation("stop")).text);
});

test("status：关着与开着说不同的话，开着的要把进度说清", () => {
  const closed = createMoRunHandler({ recorder: fakeRecorder({ status: () => ({ open: false }) }), language: () => "zh" });
  assert.match(closed(invocation("status")).text, /没有开着/);

  const open = createMoRunHandler({
    recorder: fakeRecorder({
      status: () => ({ open: true, pipelineId: "demo", startedAt: "2026-10-16T12:00:00.000Z", bufferedEvents: 7, recorded: ["P6"], unattributed: 1, ambiguous: 0, truncated: false })
    }),
    language: () => "zh"
  });
  const r = open(invocation("status"));
  assert.match(r.text, /demo/);
  assert.match(r.text, /7 条事件/);
  assert.match(r.text, /P6/);
});

test("英文实例：同一组结果翻成英文，不落回中文", () => {
  const h = createMoRunHandler({
    recorder: fakeRecorder({ stop: () => ({ ok: false, reason: "no-observations", bufferedEvents: 3, notCommands: 3 }) }),
    language: () => "en"
  });
  const r = h(invocation("stop"));
  assert.match(r.text, /nothing was persisted/i);
});

test("注册默认关：旗标不是 true 时一个命令都不注册", () => {
  const registered = [];
  const ctx = { commands: { register: (c) => { registered.push(c); return () => {}; } } };
  assert.equal(registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: false }), null);
  assert.equal(registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: undefined }), null);
  assert.equal(registered.length, 0, "默认关时不许注册");
});

test("注册打开：命令名走小写字母起头的约定，且带描述与用法提示", () => {
  const registered = [];
  const ctx = { commands: { register: (c) => { registered.push(c); return () => {}; } } };
  const dispose = registerMoRunCommand({ ctx, recorder: fakeRecorder(), enabled: true, language: () => "zh" });
  assert.equal(typeof dispose, "function");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, MO_RUN_COMMAND);
  assert.match(registered[0].name, /^[a-z][a-z0-9_-]*$/);
  assert.ok(registered[0].description);
  assert.ok(registered[0].input?.hint);
  assert.equal(typeof registered[0].handler, "function");
});

test("没有命令注册表时不硬注册（返回 null，由装配方决定要不要降级）", () => {
  assert.equal(registerMoRunCommand({ ctx: {}, recorder: fakeRecorder(), enabled: true }), null);
  assert.equal(registerMoRunCommand({ ctx: null, recorder: fakeRecorder(), enabled: true }), null);
});

test("handler 抛异常也不许把异常抛进宿主：退化成用法提示", () => {
  const h = createMoRunHandler({
    recorder: { start: () => { throw new Error("炸了"); }, stop: () => {}, status: () => {} },
    language: () => "zh"
  });
  const r = h(invocation("start demo"));
  assert.equal(r.kind, "error");
  assert.ok(r.text);
});
