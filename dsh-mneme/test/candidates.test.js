import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideDetour,
  scanIrreversible,
  projectKey,
  candidateDir,
  candidateId,
  validateCandidate,
  loadCandidates,
  saveCandidate,
  recordDetour,
  maybePropose,
  archiveStale,
  promoteCandidate,
  summarizeCandidate,
  readCandidateDoc,
  removeCandidate,
  IRREVERSIBLE_PATTERNS,
  PROMOTE_MIN_SEEN,
  STALE_AFTER_DAYS
} from "../src/candidates.js";

// 这一组守的是 M.O. 的**候选层与绕行判定**——这一版解决的是「刻板的图会让 agent 失去自主性」。
// 核心规则一句话：自主性住在 R0/R1，刚性只住在它必须住的地方。
// 里面有几条是**踩过坑才写下的**（子命令误拦、requires/forbids 语义搞反），
// 所以那些用例不是举例子，是回归锁。

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mo-cand-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STEPS = [
  { title: "看仓库干不干净", when: "发版前", do: "git status", done: "无未提交", risk: "R0" },
  { title: "跳过 release-prep", when: "上一次已 bump", do: "手工改版本号", done: "版本号对", risk: "R1" }
];

const okCandidate = (over = {}) => ({
  id: "cand-abcdef123456",
  origin: "detour",
  steps: STEPS,
  reason: "仓库干净，release-prep 这步多余",
  counterfactual: null,
  seen: [],
  status: "collecting",
  createdAt: new Date().toISOString(),
  ...over
});

// ── 分档：B 档的核心规则 ────────────────────────────────────────────────────

test("R0/R1 且不跨闸门、兜底未命中 → 记账先走（自主性住在这里）", () => {
  assert.equal(decideDetour({ risk: "R0", actions: ["gh pr view 438", "ls"] }).decidedBy, "model");
  assert.equal(decideDetour({ risk: "R1", actions: ["npm test", "git status"] }).decidedBy, "model");
  assert.equal(decideDetour({ risk: "R1", actions: [] }).decidedBy, "model");
});

test("R2/R3 → 停下等点头（刚性只住在这里）", () => {
  assert.equal(decideDetour({ risk: "R2", actions: [] }).decidedBy, "human");
  assert.equal(decideDetour({ risk: "R3", actions: [] }).decidedBy, "human");
});

test("兜底清单不看自报：自报 R0 但命令里有对外动作，照样拦", () => {
  // 这条是「模型在自己上下文里给自己打分不可靠」的直接应用——不给单点判断。
  const r = decideDetour({ risk: "R0", actions: ["git push origin main"] });
  assert.equal(r.decidedBy, "human");
  assert.equal(r.risk, "R2", "命中兜底时风险档要按较高者记，结算卡上才看得准");
  assert.deepEqual(r.scan.matches.map((m) => m.id), ["git-push"]);
});

test("自报非法风险档 → 按最保守处理，不是放行", () => {
  // 一个模型说「我的风险是 R9」时，正确的反应是别信它，而不是当成没风险。
  assert.equal(decideDetour({ risk: "R9", actions: [] }).decidedBy, "human");
  assert.equal(decideDetour({ risk: undefined, actions: [] }).decidedBy, "model");
});

test("闸门保护与风险档无关：纯只读绕行只要跨闸门也停下", () => {
  // 闸门本来就放在「错了很难撤」的地方，绕开它等于把安全阀绕掉——
  // 哪怕这条绕行本身全是只读动作。
  const r = decideDetour({ risk: "R0", actions: ["ls"], crossesGate: true });
  assert.equal(r.decidedBy, "human");
  assert.match(r.reason, /闸门/);
});

// ── 兜底清单：子命令必须分得开 ──────────────────────────────────────────────

test("兜底清单分得清只读与写：同一工具的子命令，性质相反", () => {
  // 回归锁：第一版把工具名整条当动作，`gh pr view`（只看一眼 PR）也被拦下了，
  // 直接毁掉「自主性住在 R0/R1」。工具名 + 子命令才是动作。
  const readOnly = [
    "gh pr view 438", "gh pr list", "gh pr checks", "gh pr diff",
    "gh issue view 12", "gh release view v1", "gh auth status",
    "gh api repos/x/y", "gh repo view", "gh run list",
    "git tag -l", "git status", "npm test",
    "curl https://example.com", "Remove-Item x.txt"
  ];
  for (const cmd of readOnly) {
    assert.equal(scanIrreversible([cmd]).hit, false, `只读的 ${cmd} 不该被拦`);
  }
  const writes = [
    "git push origin main", "git tag v1.0.0", "git tag -d v1",
    "gh pr create --title x", "gh pr merge 438", "gh pr close 438",
    "gh issue create -t x", "gh release create v1",
    "gh api -X POST /repos/x/y", "gh api -f name=v",
    "gh auth login", "gh secret set FOO", "gh repo edit", "gh workflow run ci.yml",
    "npm publish", "yarn publish", "pnpm publish",
    "curl -X POST https://x.com", "curl --data a=1 https://x.com",
    "Remove-Item -Recurse -Force x", "rm -rf build", "drop table memories"
  ];
  for (const cmd of writes) {
    assert.equal(scanIrreversible([cmd]).hit, true, `要写的 ${cmd} 必须被拦`);
  }
});

test("requires 与 forbids 的语义不能混：默认安全的动作只能用 requires", () => {
  // 回归锁：`gh api` 不写方法时是 GET（安全），只有显式写方法与字段才危险。
  // 用 forbids 表达「默认安全」是错的——不写方法时两个特征都不出现，
  // forbids 不成立、规则照样命中，于是只读调用被误拦。
  const api = IRREVERSIBLE_PATTERNS.find((p) => p.id === "gh-api-write");
  assert.ok(api && Array.isArray(api.requires), "gh api 那条必须用 requires");
  assert.equal(api.forbids, undefined, "同一语义不能既用 requires 又用 forbids");
  // 而「默认危险、列出只读例外」的动作用 forbids。
  const pr = IRREVERSIBLE_PATTERNS.find((p) => p.id === "gh-pr-write");
  assert.ok(pr && Array.isArray(pr.forbids));
});

test("扫多条动作：任一命中即算命中，同一条不重复算", () => {
  const r = scanIrreversible(["ls", "git push", "git push --tags"]);
  assert.equal(r.hit, true);
  assert.equal(r.matches.filter((m) => m.id === "git-push").length, 1);
  assert.equal(scanIrreversible([]).hit, false);
  assert.equal(scanIrreversible(null).hit, false);
});

// ── 候选的住址与身份 ───────────────────────────────────────────────────────

test("项目键稳定、不含绝对路径（文件名里不能有本机用户名）", () => {
  const a = projectKey("C:\\Users\\someone\\Desktop\\dsh-mneme");
  const b = projectKey("C:\\Users\\someone\\Desktop\\dsh-mneme");
  const other = projectKey("C:\\Users\\someone\\Desktop\\another-project");
  assert.equal(a, b, "同一个项目每次算到同一个键");
  assert.notEqual(a, other, "不同项目必须分开");
  assert.equal(a.includes("someone"), false, "不能把用户名带进文件名");
  assert.ok(a.startsWith("dsh-mneme-"), "保留目录名便于人读");
  assert.equal(projectKey(""), null);
  assert.equal(projectKey(null), null);
});

test("项目键对两种分隔符一视同仁：Windows 路径不得退化成整条路径", () => {
  // 回归锁，指向一个**只在 posix 上现形**的缺陷：原实现借 path.basename() 取目录名，
  // 它跟着运行平台走——Linux 上 `C:\Users\someone\Desktop\dsh-mneme` 整条被当成
  // 文件名，清洗后 C--Users-someone-Desktop-dsh-mne，用户名的残片进了目录名。
  // 这正是 PR #439 里 ubuntu 四腿全红、windows 两腿全绿的那条。
  //
  // **这条锁在 Windows 上是绿的，且永远抓不住回退**：win32.basename 两种分隔符都认，
  // 旧实现在本机结果就是对的。它的杀伤力只在 ubuntu 矩阵腿上——别删了它以为没事。
  const nameOf = (key) => key.replace(/-[0-9a-f]{8}$/, "");
  const bs = projectKey("C:\\Users\\someone\\Desktop\\dsh-mneme");
  const fwd = projectKey("C:/Users/someone/Desktop/dsh-mneme");
  const trail = projectKey("C:\\Users\\someone\\Desktop\\dsh-mneme\\");
  assert.equal(nameOf(bs), "dsh-mneme", "反斜杠路径要取到目录名");
  assert.equal(nameOf(fwd), "dsh-mneme", "正斜杠路径要取到目录名");
  assert.equal(nameOf(trail), "dsh-mneme", "尾随分隔符不改变结果");
  assert.equal(bs.includes("someone"), false, "用户名不得进目录名");
  assert.equal(bs.includes("-Users-"), false, "整条路径不得被清洗成目录名");
  assert.match(bs, /^[A-Za-z0-9._-]+$/, "目录名只许出现安全字符");
});


test("候选的家在 memoryDir 下、按项目分桶；拿不到项目根就没有家", () => {
  const dir = candidateDir({ memoryDir: "~/.dsh/memory", projectRoot: "C:\\x\\y" });
  assert.ok(dir && dir.includes("candidates"), "落在 candidates/ 下");
  assert.equal(dir.includes("C:\\x\\y"), false, "路径不进字符串");
  assert.equal(candidateDir({ memoryDir: "/tmp/m", projectRoot: null }), null);
});

test("候选 id 由步骤形状决定：同一段路走两次会落到同一条上", () => {
  // 这正是「复用第二次才算类型，第一次只是实例」的落点——
  // 如果每次绕行都生成新 id，第二次永远并不到第一次上，门槛就永远够不着。
  const id1 = candidateId(STEPS);
  const id2 = candidateId(STEPS.map((s) => ({ ...s })));
  const id3 = candidateId([STEPS[0], { ...STEPS[1], title: "换了个做法" }]);
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.match(id1, /^cand-[0-9a-f]{12}$/);
});

// ── 校验：候选松，但 reason 一个都不能少 ────────────────────────────────────

test("候选比定稿松，但「写不出理由就不许绕」是硬要求", () => {
  assert.equal(validateCandidate(okCandidate()).ok, true);
  // 定稿要求 id/name/project/version/status/done/trigger 一个不缺；候选只要这四样。
  const minimal = { id: "cand-abcdef123456", origin: "manual", steps: STEPS, reason: "为什么", seen: [], status: "collecting" };
  assert.equal(validateCandidate(minimal).ok, true, "候选不该要求定稿那一整套字段");

  const noReason = validateCandidate(okCandidate({ reason: "   " }));
  assert.equal(noReason.ok, false);
  assert.ok(noReason.problems.some((p) => p.includes("reason 必填")));

  assert.equal(validateCandidate(okCandidate({ id: "bad-id" })).ok, false);
  assert.equal(validateCandidate(okCandidate({ origin: "telepathy" })).ok, false);
  assert.equal(validateCandidate(okCandidate({ status: "whatever" })).ok, false);
  assert.equal(validateCandidate(okCandidate({ steps: [] })).ok, false);
  assert.equal(validateCandidate(okCandidate({ steps: [{ title: "x" }] })).ok, false, "步骤缺字段要报出来");
  assert.equal(validateCandidate(null).ok, false);
});

test("坏文件不静默跳过：与定稿同一纪律", () => {
  withDir((dir) => {
    saveCandidate(dir, okCandidate());
    assert.equal(loadCandidates(dir).length, 1);
    rmSync(join(dir, "cand-abcdef123456.json"));
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    assert.throws(() => loadCandidates(dir), /broken\.json: JSON 解析失败/);
  });
});

// ── 绕行 → 候选：两次才算数 ─────────────────────────────────────────────────

test("第一次绕行：落成候选，但还够不着提议", () => {
  withDir((dir) => {
    const r = recordDetour(dir, { steps: STEPS, reason: "仓库干净，这步多余", outcome: "worked", evidence: ["测试全绿"], runId: "r1" });
    assert.equal(r.created, true);
    assert.equal(r.promotedNow, false);
    assert.equal(r.candidate.status, "collecting");
    assert.equal(r.candidate.seen.length, 1);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  });
});

test(`第二次走同一段路：并进同一条，翻成 proposed（门槛 ${PROMOTE_MIN_SEEN} 次）`, () => {
  withDir((dir) => {
    recordDetour(dir, { steps: STEPS, reason: "同上", outcome: "worked", evidence: ["绿"], runId: "r1" });
    const b = recordDetour(dir, { steps: STEPS, reason: "同上", outcome: "worked", evidence: ["又绿"], runId: "r2" });
    assert.equal(b.created, false, "不该新建——同一段路只有一条候选");
    assert.equal(b.promotedNow, true);
    assert.equal(b.candidate.status, "proposed");
    assert.equal(b.candidate.seen.length, 2);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  });
});

test("两次里只要有一次没跑通，就够不着提议", () => {
  // 「复用第二次才算类型」的前提是**那次真的走通了**；两次都失败的路不该被提议进图。
  const c = okCandidate({ seen: [{ outcome: "failed" }, { outcome: "unknown" }] });
  assert.equal(maybePropose(c), false);
  assert.equal(c.status, "collecting");
  const d = okCandidate({ seen: [{ outcome: "failed" }, { outcome: "worked" }] });
  assert.equal(maybePropose(d), true, "有一次跑通就算走通了这条路");
});

test("失败也留痕：走不通是知识，不是垃圾", () => {
  withDir((dir) => {
    recordDetour(dir, { steps: STEPS, reason: "试试", outcome: "failed", evidence: ["C2 直接报错"] });
    const [c] = loadCandidates(dir);
    assert.equal(c.seen[0].outcome, "failed");
    assert.deepEqual(c.seen[0].evidence, ["C2 直接报错"]);
    const row = summarizeCandidate(c);
    assert.equal(row.failed, 1);
    assert.equal(row.worked, 0);
  });
});

// ── 归档与升格 ─────────────────────────────────────────────────────────────

test(`只走过一次、${STALE_AFTER_DAYS} 天没再被走到 → 归档；归档不删文件`, () => {
  withDir((dir) => {
    const old = okCandidate({
      seen: [{ outcome: "worked", at: new Date(Date.now() - (STALE_AFTER_DAYS + 10) * 86400000).toISOString() }]
    });
    saveCandidate(dir, old);
    const archived = archiveStale(dir, {});
    assert.deepEqual(archived, [old.id]);
    const after = loadCandidates(dir).find((c) => c.id === old.id);
    assert.equal(after.status, "dropped");
    assert.match(after.droppedReason, /没再被走到/);
    assert.ok(readdirSync(dir).some((f) => f.startsWith(old.id)), "文件还在——留着当负清单的邻居");
  });
});

test("归档只碰 collecting：够格的和已归档的都不动", () => {
  withDir((dir) => {
    const proposed = okCandidate({ id: "cand-proposed0001", status: "proposed", seen: [{ outcome: "worked", at: new Date(Date.now() - 100 * 86400000).toISOString() }] });
    const fresh = okCandidate({ id: "cand-fresh0000001", seen: [{ outcome: "worked", at: new Date().toISOString() }] });
    saveCandidate(dir, proposed);
    saveCandidate(dir, fresh);
    assert.deepEqual(archiveStale(dir, {}), []);
  });
});

test("升格：补齐字段后必须过定稿的 validatePipeline", () => {
  const cand = okCandidate();
  const good = promoteCandidate(cand, { name: "发版（绕开 release-prep）", project: "slow-stack/mneme", done: "发出去且 registry 对得上" });
  assert.equal(good.ok, true);
  assert.equal(typeof good.pipeline.id, "string");
  assert.equal(good.pipeline.id.startsWith("cand-"), false, "句柄要去掉 cand- 前缀");
  assert.deepEqual(good.pipeline.steps[1].needs, ["S1"], "needs 要串成链，否则定稿那边会报图不连通");
  assert.equal(good.pipeline.version, 0);
  // 升格不是降低标准，是补齐标准：缺 project 照样过不了。
  const bad = promoteCandidate(cand, { name: "缺 project" });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("project")));
});

test("升格带上候选的反事实——它是准入判据，不是备注", () => {
  const cand = okCandidate({ counterfactual: "没有它，C 阶段会拿旧版本号发出去" });
  const r = promoteCandidate(cand, { name: "x", project: "a/b" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pipeline.steps[0].evidence, ["没有它，C 阶段会拿旧版本号发出去"]);
});

// ── 投影与契约 ─────────────────────────────────────────────────────────────

test("清单行取整段路里最高的风险档（最坏情况才是它该被看待的档位）", () => {
  const row = summarizeCandidate(okCandidate({ steps: [STEPS[0], STEPS[1], { title: "问人", when: "w", do: "d", done: "x", risk: "R2" }] }));
  assert.equal(row.risk, "R2");
  assert.equal(row.steps, 3);
});

test("契约把「这一刀不做的事」也写进去，免得以后有人以为忘了做", () => {
  withDir((dir) => {
    const doc = readCandidateDoc({ memoryDir: dir, projectRoot: "C:\\x\\y" });
    assert.equal(doc.contract, "mneme.candidates/v1");
    assert.deepEqual(doc.boundaries, { autoPromote: false, autoApprove: false, injectIntoMemory: false });
    assert.deepEqual(doc.counts, { collecting: 0, proposed: 0, promoted: 0, dropped: 0 });
  });
});

test("removeCandidate 只删指定的那条", () => {
  withDir((dir) => {
    saveCandidate(dir, okCandidate());
    saveCandidate(dir, okCandidate({ id: "cand-second000001" }));
    assert.equal(removeCandidate(dir, "cand-abcdef123456"), true);
    assert.equal(loadCandidates(dir).length, 1);
    assert.equal(removeCandidate(dir, "cand-nope00000000"), false);
  });
});
