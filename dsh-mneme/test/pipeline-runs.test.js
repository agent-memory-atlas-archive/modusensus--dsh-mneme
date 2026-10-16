import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPipelineDoc } from "../src/pipeline.js";
import {
  runsPath,
  readRuns,
  appendRun,
  normalizeRun,
  loadRunsById,
  RunError
} from "../src/pipeline-runs.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

// 这组测试守的是 M.O. 执行链的**第一步**：把「跑过一次」真的写下来，并让读侧读得回来。
//
// 为什么单独一个文件：读侧（src/pipeline.js）的契约已冻结，这里守的是它与盘面的接缝
// ——落点在哪、坏行怎么报、写进去的东西能不能被 tallyRuns 数出来。接缝坏掉时读侧
// 一切照旧地绿，只有面板上「所有节点都是 candidate」这一个症状，最容易查不出来。

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-runs-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 与 test/pipeline.test.js 同款的最小工作流：两条步骤，引用自洽，够验投影。
function pipelineFile(steps) {
  return JSON.stringify({
    id: "demo",
    name: "演示",
    project: "someone/repo",
    version: 0,
    status: "active",
    done: "做完",
    trigger: [{ kind: "phrase", value: "跑一下" }],
    steps:
      steps ||
      [
        {
          id: "A1",
          phase: "准备",
          title: "第一步",
          when: "有人要跑",
          do: "做一件事",
          who: "main",
          tool: "true",
          done: "这件事做完了",
          risk: "R0",
          needs: [],
          why: "没有它后面没得跑",
          evidence: ["上次没有它，跑到一半才发现前置没做"]
        },
        {
          id: "A2",
          phase: "收尾",
          title: "第二步",
          when: "第一步做完",
          do: "做另一件事",
          who: "main",
          tool: "true",
          done: "这件事也做完了",
          risk: "R0",
          needs: ["A1"],
          why: "没有它没人知道跑完了",
          evidence: ["上次漏了它，以为没跑完"]
        }
      ]
  });
}

function seededProject(root, { runs = null, steps = null } = {}) {
  const dir = join(root, ".mneme", "pipelines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "demo.json"), pipelineFile(steps), "utf8");
  if (runs !== null) writeFileSync(join(dir, "demo.runs.jsonl"), runs, "utf8");
  return dir;
}

function goodRun(overrides = {}) {
  return {
    at: "2026-10-15T09:00:00.000Z",
    by: "main",
    triggeredBy: "跑一下",
    steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }],
    ...overrides
  };
}

// ── 落点：与人手写的 .json 分开 ────────────────────────────────────────────────

test("落点是 <项目>/.mneme/pipelines/<id>.runs.jsonl，与手写的 .json 分开", () => {
  // 分开是刻意的：.json 是人手写、要 review、要提交的；.runs.jsonl 是每次都追加的
  // 运行账。同住一个文件的话，一次 run 就会把人的 diff 冲掉。
  const root = join(tmpdir(), "proj");
  const p = runsPath(root, "demo");
  assert.equal(p, join(root, ".mneme", "pipelines", "demo.runs.jsonl"));
  assert.equal(p.endsWith(".runs.jsonl"), true);
  // 账本与手写文件同目录但不同名：同 id 的 .json 不受影响。
  assert.equal(p === join(root, ".mneme", "pipelines", "demo.json"), false);
});

test("id 不是文件名，是**一个**文件名：路径穿越与绝对路径都拒掉", () => {
  // 拒而不是清洗：清洗过的 id 会指向一个用户没指定的文件，那是更难查的一类错。
  const root = join(tmpdir(), "proj");
  assert.throws(() => runsPath(root, "../../etc/passwd"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, "a/b"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, "a\\b"), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, ".."), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, ""), (e) => e.name === "RunError");
  assert.throws(() => runsPath(root, null), (e) => e.name === "RunError");
});

// ── 读侧：空是实话，坏行要说话 ────────────────────────────────────────────────

test("目录不存在、文件不存在、空文件都返回空数组，不是抛", () => {
  // 从没跑过一条工作流是**正常状态**（面板画空态），不是错误。
  withDir((root) => {
    assert.deepEqual(readRuns(root, "demo"), []);
    const dir = seededProject(root);
    assert.deepEqual(readRuns(root, "demo"), []);
  });
});

test("坏行不静默跳过：报出来，并指到第几行", () => {
  // 与 loadPipelines 同一纪律。静默少一条最难查——面板上看起来只是「这条工作流
  // 好像没跑过」，而真相是账本里有一行读不出来。
  withDir((root) => {
    const dir = seededProject(root);
    writeFileSync(
      join(dir, "demo.runs.jsonl"),
      [JSON.stringify(goodRun()), "{ 半个对象", JSON.stringify(goodRun())].join("\n") + "\n",
      "utf8"
    );
    assert.throws(
      () => readRuns(root, "demo"),
      (error) => {
        assert.equal(error.name, "RunError");
        assert.match(error.message, /demo\.runs\.jsonl/);
        assert.match(error.message, /第 2 行/);
        return true;
      }
    );
  });
});

test("形状不对的行也报错：by 必须落在 ACTORS 里、steps 不能空", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeFileSync(join(dir, "demo.runs.jsonl"), JSON.stringify(goodRun({ by: "robot" })) + "\n", "utf8");
    assert.throws(() => readRuns(root, "demo"), (e) => /by/.test(e.message));

    writeFileSync(join(dir, "demo.runs.jsonl"), JSON.stringify(goodRun({ steps: [] })) + "\n", "utf8");
    assert.throws(() => readRuns(root, "demo"), (e) => /steps/.test(e.message));
  });
});

test("多行按顺序读回来，每行一条 run", () => {
  withDir((root) => {
    const dir = seededProject(root);
    const two = [goodRun({ at: "2026-10-14T09:00:00.000Z" }), goodRun({ at: "2026-10-15T09:00:00.000Z" })];
    writeFileSync(join(dir, "demo.runs.jsonl"), two.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const runs = readRuns(root, "demo");
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.at), ["2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]);
    // 补齐默认值：读侧拿到的每一行形状都一样，tallyRuns 不用再判 undefined。
    assert.equal(runs[0].steps[0].skipped, false);
    assert.equal(runs[0].steps[0].detoured, false);
    assert.equal(runs[0].steps[0].refuted, false);
    assert.equal(runs[0].steps[0].note, "");
  });
});

// ── 写侧：一行一条，形状由一条规范化函数保证 ──────────────────────────────────

test("normalizeRun 把一条 run 收成契约形状（缺的补默认、多余的丢掉）", () => {
  const run = normalizeRun({
    at: "2026-10-15T09:00:00.000Z",
    by: "subagent",
    triggeredBy: "跑一下",
    steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z", skipped: true, note: "这次不用" }]
  });
  assert.deepEqual(run, {
    at: "2026-10-15T09:00:00.000Z",
    by: "subagent",
    triggeredBy: "跑一下",
    steps: [
      {
        id: "A1",
        at: "2026-10-15T09:00:01.000Z",
        skipped: true,
        detoured: false,
        refuted: false,
        note: "这次不用"
      }
    ]
  });
});

test("时间戳收成 ISO 毫秒：Date 与 ISO 串进来都落成同一个形状", () => {
  const fromDate = normalizeRun(goodRun({ at: new Date("2026-10-15T09:00:00.000Z") }));
  assert.equal(fromDate.at, "2026-10-15T09:00:00.000Z");
  assert.throws(() => normalizeRun(goodRun({ at: "不是时间" })), (e) => e.name === "RunError");
  assert.throws(() => normalizeRun(goodRun({ at: undefined })), (e) => e.name === "RunError");
});

test("expectedStepIds：图上没有的步骤 id 报出来，不许悄悄记进去", () => {
  // 记进去会让 tallyRuns 数出一个不属于任何节点的账，于是面板上没有任何地方显示它
  // ——这条 run 就成了「写了但看不见」。
  const bad = goodRun({ steps: [{ id: "NOPE", at: "2026-10-15T09:00:01.000Z" }] });
  assert.throws(() => normalizeRun(bad, { expectedStepIds: ["A1", "A2"] }), (e) => /NOPE/.test(e.message));
  assert.doesNotThrow(() => normalizeRun(bad));
});

test("appendRun 一次一行：目录自己建、已有内容不以换行结尾也不会粘行", () => {
  withDir((root) => {
    // 目录都不存在时也要能落下来——第一次跑一条工作流就是这个状态。
    appendRun(root, "demo", goodRun({ at: "2026-10-14T09:00:00.000Z" }));
    assert.equal(existsSync(runsPath(root, "demo")), true);

    // 手工写一条**不带结尾换行**的半行（模拟被别的东西截断/手写过的账本）：
    // 直接追加会把两条 run 粘成一条，于是一行坏 JSON 把整个账本读不出来。
    writeFileSync(runsPath(root, "demo"), JSON.stringify(goodRun({ at: "2026-10-14T09:00:00.000Z" })), "utf8");
    appendRun(root, "demo", goodRun({ at: "2026-10-15T09:00:00.000Z" }));

    const runs = readRuns(root, "demo");
    assert.equal(runs.length, 2, "两条 run 必须各自成行");
    assert.deepEqual(runs.map((r) => r.at), ["2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]);
  });
});

// ── 接线：写下去的那条 run 要能被读侧数出来 ──────────────────────────────────

test("行为级：一次 run 落盘后，readPipelineDoc 的 nodes[].credit 与 state 真的变了", () => {
  withDir((root) => {
    seededProject(root);

    // 写之前：没有账 → 全体 candidate（这是读侧如实说的「还没跑过」）。
    const before = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root });
    assert.deepEqual([...new Set(before.nodes.map((n) => n.state))], ["candidate"]);

    appendRun(root, "demo", {
      at: "2026-10-15T09:00:00.000Z",
      by: "human",
      triggeredBy: "跑一下",
      steps: [
        { id: "A1", at: "2026-10-15T09:00:01.000Z" },
        { id: "A2", at: "2026-10-15T09:00:02.000Z", refuted: true }
      ]
    });

    const runsById = loadRunsById(root, ["demo"]).runsById;
    const after = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById });
    assert.equal(after.runs.length, 1);

    const byId = Object.fromEntries(after.nodes.map((n) => [n.id, n]));
    // 照图走了、没被推翻 → trusted，并记下用了 1 次与最后一次的时间。
    assert.equal(byId.A1.state, "trusted");
    assert.deepEqual(byId.A1.credit, { uses: 1, refuted: 0, skipped: 0, detoured: 0, lastUsedAt: "2026-10-15T09:00:01.000Z" });
    // 走过但被推翻 → refuted：这是唯一有硬判据的信号，染色留给它。
    assert.equal(byId.A2.state, "refuted");
    assert.equal(byId.A2.credit.refuted, 1);
    assert.equal(byId.A2.credit.uses, 1);

    // 清单页的账也要跟着动：首屏不能还是「全 candidate」。
    assert.deepEqual(after.available[0].states, { candidate: 0, trusted: 1, stale: 0, refuted: 1 });
  });
});

test("行为级：跳过与绕开各自独立累加，谁都不吞谁（两种提议一起发得出来）", () => {
  withDir((root) => {
    seededProject(root);
    // 一次同时「跳过」+「绕开」：两件事驱动的提议不同（删这一步 / 重画这条路），
    // 第一版写成 if/else if 时绕行把跳过吃掉了，两种提议一起哑掉。
    const line = {
      id: "A1",
      at: "2026-10-15T09:00:01.000Z",
      skipped: true,
      detoured: true
    };
    for (const at of ["2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]) {
      appendRun(root, "demo", { at, by: "main", triggeredBy: "", steps: [line] });
    }

    const runsById = loadRunsById(root, ["demo"]).runsById;
    const doc = readPipelineDoc({ projectRoot: root, id: "demo", pluginDir: root, runsById });
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.credit.uses, 0, "跳过/绕开都不是「用了这一步」");
    assert.equal(a1.credit.skipped, 3);
    assert.equal(a1.credit.detoured, 3);

    // 计数到阈值就该冒出提议——这是执行链存在的理由：不用人等巡检。
    const kinds = doc.suggestions.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["drop-step", "rework-path"].sort(), JSON.stringify(doc.suggestions));
    // 绕开不染色：被绕开不等于这一步坏了，染色留给真正被推翻过的。
    assert.equal(a1.state, "stale", "一次都没用上但有跳过记录 → stale，不是 refuted");
  });
});

// ── 端点接线：面板拿得到的那一份 ──────────────────────────────────────────────

class FakeRes {
  constructor() {
    this.statusCode = 200;
    this.body = "";
  }
  writeHead(code) {
    this.statusCode = code;
    return this;
  }
  end(text) {
    this.body = text ?? "";
    return this;
  }
}

function buildApi() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  createApi(ctx, service, settings, { add() {}, remove() {}, list: () => [] }, null, undefined, "");
  return { routes };
}

test("端点接线：/pipeline 喂上 runsById，面板拿到的不再是全体 candidate", () => {
  withDir((root) => {
    seededProject(root);
    appendRun(root, "demo", goodRun({ steps: [{ id: "A1", at: "2026-10-15T09:00:01.000Z" }] }));

    const api = buildApi();
    const route = api.routes.find((r) => r.path === "/api/dsh-mneme/pipeline");
    const res = new FakeRes();
    route.handler({
      url: "/api/dsh-mneme/pipeline?id=demo&project=" + encodeURIComponent(root),
      method: "GET",
      headers: {}
    }, res);
    assert.equal(res.statusCode, 200);
    const doc = JSON.parse(res.body);
    assert.equal(doc.runs.length, 1, "run 记录要走到投影里");
    const a1 = doc.nodes.find((n) => n.id === "A1");
    assert.equal(a1.state, "trusted");
    assert.equal(a1.credit.uses, 1);
    assert.deepEqual(doc.runsErrors, [], "账本读得出来时不该有噪音");
  });
});

test("端点接线：账本坏掉时说清坏在哪，而且不拖死清单页", () => {
  withDir((root) => {
    const dir = seededProject(root);
    writeFileSync(join(dir, "demo.runs.jsonl"), "{ 半个对象\n", "utf8");
    const api = buildApi();
    const route = api.routes.find((r) => r.path === "/api/dsh-mneme/pipeline");

    // 清单页照样出得来：一条坏账本不该让整个面板打不开（与项目层坏 .json 同一口径）。
    const list = new FakeRes();
    route.handler({ url: "/api/dsh-mneme/pipeline?project=" + encodeURIComponent(root), method: "GET", headers: {} }, list);
    assert.equal(list.statusCode, 200);
    const listDoc = JSON.parse(list.body);
    assert.ok(listDoc.pipeline, "清单页还在");
    assert.equal(listDoc.runsErrors.length, 1);
    assert.equal(listDoc.runsErrors[0].id, "demo");
    assert.match(listDoc.runsErrors[0].detail, /demo\.runs\.jsonl/);

    // 明确点这条工作流时说清坏在哪：静默给一份「没跑过」等于骗人。
    const one = new FakeRes();
    route.handler({
      url: "/api/dsh-mneme/pipeline?id=demo&project=" + encodeURIComponent(root),
      method: "GET",
      headers: {}
    }, one);
    assert.equal(one.statusCode, 500);
    assert.equal(JSON.parse(one.body).error, "pipeline-unreadable");
    assert.match(JSON.parse(one.body).detail, /demo\.runs\.jsonl/);
  });
});

test("loadRunsById 只读问到的那些 id，没问到的连盘都不碰", () => {
  withDir((root) => {
    const dir = seededProject(root);
    appendRun(root, "demo", goodRun());
    // 同目录里再放一份别人的账本：它没被问到，就不该出现在结果里。
    writeFileSync(join(dir, "other.runs.jsonl"), "{ 半个对象\n", "utf8");

    const { runsById, errors } = loadRunsById(root, ["demo", "never-written"]);
    assert.deepEqual(Object.keys(runsById).sort(), ["demo", "never-written"]);
    assert.equal(runsById.demo.length, 1);
    assert.deepEqual(runsById["never-written"], [], "没跑过就是空数组，不是报错");
    assert.deepEqual(errors, [], "没被问到的坏账本不该污染这次读数");
  });
});
