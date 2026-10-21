// issue #231 的第二批：把已造好的整理引擎接到 agent 的调用面上（organizeEnabled
// + memory_organize 工具）。src/organize.js 的本体语义由 test/organize.test.js 守，
// 本文件只守**出口**这一层：闸门、报告/落地的两步协议、以及 strictScope 下
// 「看不见的行按不存在处理」这条可信上下文。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import { applyLightModePreset } from "../src/config.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  createTools(ctx, service, config, undefined);
  const byName = Object.fromEntries(registered.map((def) => [def.name, def]));
  return { store, service, byName, registered };
}

const CANDIDATES = [
  { type: "project", title: "发布只在包目录内", content: "根目录发过坏包，发布必须在 dsh-mneme/ 内执行。" },
  { type: "project", title: "另一条", content: "第二条候选的正文。" }
];

test("memory_organize registers when organizeEnabled is on", async () => {
  const { byName } = setup({ organizeEnabled: true });
  const tool = byName.memory_organize;
  assert.ok(tool, "organizeEnabled=true 应当注册 memory_organize");
  const report = await tool.execute({ mode: "dryRun", candidates: CANDIDATES });
  assert.equal(report.status, "ok");
  assert.equal(report.counts.total, 2, "两条候选都应进报告");
  assert.equal(report.run_id ? typeof report.run_id : "none", "string", "dryRun 必须回一个 run_id 供 apply 引用");
});

// 默认关=零行为变化是仓库红线（AGENTS.md 自查清单第 1 条）。这条现在就会绿——
// 它防的是「以后有人把默认翻成 true」，而不是今天的缺失实现。
test("memory_organize stays unregistered by default", () => {
  const { registered } = setup();
  assert.equal(registered.some((t) => t.name === "memory_organize"), false, "organizeEnabled 缺省时不得注册");
});

test("lightMode preset turns organize off, but an explicit user switch wins", () => {
  // 轻量档那一格是**预设**，不是强制（合并顺序「用户开关 > 轻量预设 > bundle」在
  // index.js），所以这里断言的是预设值本身——同 continuity.test.js 的
  // continuityRescueEnabled 那条。工具侧的注册与否由上一条默认关用例守着。
  assert.equal(applyLightModePreset({ lightMode: true }).organizeEnabled, false);
  assert.equal(applyLightModePreset({ lightMode: true, organizeEnabled: true }).organizeEnabled, false, "预设写死 false，赢的是合并时的用户开关，不是这里");
});

test("dryRun writes no memory rows but leaves one organize audit row", () => {
  const { store, byName } = setup({ organizeEnabled: true });
  return byName.memory_organize.execute({ mode: "dryRun", candidates: CANDIDATES }).then((report) => {
    assert.deepEqual(store.list({ limit: null }), [], "比对是报告，不是动作：记忆表必须一行不写");
    const runs = store.listDreamRuns({ limit: 10 });
    assert.equal(runs.length, 1, "dryRun 只留 dream_runs 一行回执");
    assert.equal(runs[0].run_type, "organize");
    assert.equal(runs[0].id, report.run_id);
  });
});

test("apply lands the decisions it references and reports counters", async () => {
  const { store, byName } = setup({ organizeEnabled: true });
  const report = await byName.memory_organize.execute({ mode: "dryRun", candidates: CANDIDATES });
  const applied = await byName.memory_organize.execute({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "discard", index: 1 }
    ]
  });
  assert.equal(applied.saved, 1, "只数新建的行");
  assert.equal(applied.discarded, 1);
  assert.equal(applied.status, "ok");
  assert.equal(store.list({ limit: null }).length, 1, "一条 save、一条 discard → 库里只有一行");
  const types = store.listDreamRuns({ limit: 10 }).map((r) => r.run_type);
  assert.deepEqual(types, ["organize", "organize"], "报告与落地各留一行审计");
});

test("apply refuses a run_id that was never reported", async () => {
  const { byName } = setup({ organizeEnabled: true });
  await assert.rejects(
    () => byName.memory_organize.execute({ mode: "apply", run_id: "no-such-run", decisions: [{ action: "discard", index: 0 }] }),
    /unknown organize run/,
    "没有比对过的候选一律不落库（organize 硬规则 2）"
  );
});

test("apply refuses a missing run_id", async () => {
  const { byName } = setup({ organizeEnabled: true });
  await assert.rejects(
    () => byName.memory_organize.execute({ mode: "apply", decisions: [{ action: "discard", index: 0 }] }),
    /run_id is required/,
    "apply 必须引用一次真实 dryRun"
  );
});

// 整理接口不能成为第二条「写进库却不带 scope」的通道：memory_save 在 scopeEnabled
// 下按会话身份盖 auto 章，organize 落地的候选必须同源。显式参数改盖 explicit，
// 与 memory_save / memory_register_document 同一规则。
test("save lands candidates stamped with the session scope (auto), like memory_save", async () => {
  const { store, byName } = setup({ organizeEnabled: true, scopeEnabled: true });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "me", cwd: "D:\\p" } } } };
  const report = await byName.memory_organize.execute({ mode: "dryRun", candidates: CANDIDATES }, exec);
  await byName.memory_organize.execute({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }, exec);
  const row = store.list({ limit: null })[0];
  assert.equal(row.agent_scope, "me", "缺省吃会话身份");
  assert.equal(row.agent_scope_source, "auto");
  assert.equal(row.workspace_scope, "D:\\p");
});

test("explicit scope arguments stamp as explicit and win over the session label", async () => {
  const { store, byName } = setup({ organizeEnabled: true, scopeEnabled: true });
  const exec = { agent: { session: { id: "s1", header: { agentPreset: "me", cwd: "D:\\p" } } } };
  const report = await byName.memory_organize.execute(
    { mode: "dryRun", candidates: CANDIDATES, agent_scope: "other-agent" },
    exec
  );
  await byName.memory_organize.execute({ mode: "apply", run_id: report.run_id, decisions: [{ action: "save", index: 0 }] }, exec);
  const row = store.list({ limit: null })[0];
  assert.equal(row.agent_scope, "other-agent", "显式参数盖在会话身份之上");
  assert.equal(row.agent_scope_source, "explicit");
});

test("unknown mode is rejected", async () => {
  const { byName } = setup({ organizeEnabled: true });
  await assert.rejects(() => byName.memory_organize.execute({ mode: "force" }), /unknown mode/);
});

// #170 复核项 4 的口径延伸到整理接口：他 scope 的 explicit 行按「不存在」处理。
// 工具若不把 hiddenIds 传下去，apply 就能归档报告里看不见别人库的行——整理接口
// 成了第二条绕过 scope 治理的改库通道（opts 是可信上下文，绝不取 payload 字段）。
// #170 复核项 4 的口径延伸到整理接口。用例形状是刻意挑的：比对键只看三列**值**
// （sensitivity/agent/workspace），可见性还多认一个 explicit 来源，所以要造出
// 「报告确实命中它、但调用方看不见它」那一格——匿名会话（解析不到 agentPreset）
// 对 explicit 行 fail-closed。少了工具侧那段 hiddenIds，archive 就能归档这一行：
// 整理接口成了第二条绕过 scope 治理的改库通道（opts 是可信上下文，绝不取 payload 字段）。
test("archive of a row the report matched but the caller cannot see is skipped", async () => {
  const config = { organizeEnabled: true, scopeEnabled: true, strictScope: true };
  const { store, byName } = setup(config);
  const teamRow = store.save({
    type: "project",
    title: "发布只在包目录内",
    content: "team-a 名下的旧行。",
    agent_scope: "team-a",
    agent_scope_source: "explicit",
    workspace_scope: "D:\\p",
    workspace_scope_source: "auto"
  });
  const exec = { agent: { session: { id: "s-anon", header: { cwd: "D:\\p" } } } };

  const report = await byName.memory_organize.execute(
    {
      mode: "dryRun",
      candidates: [{ type: "project", title: "发布只在包目录内", content: "换一种说法的同一件事。" }],
      agent_scope: "team-a",
      workspace_scope: "D:\\p"
    },
    exec
  );
  assert.equal(report.items[0].verdict, "exact", "同比对键 → 报告必须命中它，否则这条用例什么也没守");
  assert.equal(report.items[0].match.id, teamRow.id);

  const applied = await byName.memory_organize.execute(
    { mode: "apply", run_id: report.run_id, decisions: [{ action: "archive", id: teamRow.id }] },
    exec
  );
  assert.equal(applied.archived, 0, "看不见的行按不存在处理，不得归档");
  assert.equal(applied.skipped.length, 1);
  assert.match(applied.skipped[0].error, /out of scope/, "文案维持「unknown, archived or out of scope」：不泄漏存在性");
  assert.equal(store.getById(teamRow.id).archived, false, "他人的行原样未动");
});
