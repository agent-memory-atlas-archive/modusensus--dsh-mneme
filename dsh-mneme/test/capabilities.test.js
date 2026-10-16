/**
 * 能力清单读侧（src/capabilities.js）的回归测试。
 *
 * 本文件锁的重点不是 happy path，而是**两类容易被做错的判断**：
 *   ① 「坏」与「警告」的分界——第一版把「name 与目录名不一致」当坏，一次误报 20 例；
 *      实测宿主以 frontmatter 的 name 为身份（`react-three-fiber/` 里声明
 *      `threejs-scene-builder`），所以那条**不是错**。这里的用例就是钉死这个分界。
 *   ② 块标量（`description: |`）要真读出来——第一版把 `|` 当「不解析就丢」，误报
 *      55 个技能「没有 description」。
 * 两条都属同一类回归：**假警报会让人去改一个没坏的东西**，比漏报更坏。
 *
 * 另外钉死：没有项目根时**不得**回退到进程 cwd（读盘范围的正确性）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

import {
  parseFrontmatter,
  parsePatchEntries,
  scanSkillRoot,
  skillRoots,
  resolveContext,
  discoverCapabilities
} from "../src/capabilities.js";

/** 造一个临时技能根；返回 {root, skillDir} 供断言用。 */
function makeSkillRoot() {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-"));
  const root = join(base, "skills");
  mkdirSync(root, { recursive: true });
  return {
    base,
    root,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

/** 写一个技能目录（<root>/<dirName>/SKILL.md）。 */
function writeSkill(root, dirName, body) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
}

test("frontmatter：单行标量、引号、块标量都要读出来", () => {
  const text = [
    "---",
    'name: demo-skill',
    'description: "一行描述"',
    "metadata:",
    '  author: "someone"',
    "---",
    "",
    "# 正文不该被当成 frontmatter"
  ].join("\n");
  const fm = parseFrontmatter(text);
  assert.equal(fm.fields.name, "demo-skill");
  assert.equal(fm.fields.description, "一行描述");
  // 嵌套映射只记「有这个键」，不解析其内部
  assert.equal(fm.fields.metadata, "");
  assert.deepEqual(fm.problems, []);
});

test("frontmatter：块标量 | 与 > 要分别按字面/折叠处理", () => {
  const literal = ["---", "name: a-b", "description: |", "  第一行", "  第二行", "---", ""].join("\n");
  const fmLiteral = parseFrontmatter(literal);
  assert.equal(fmLiteral.fields.description, "第一行\n第二行");

  const folded = ["---", "name: a-b", "description: >", "  第一行", "  第二行", "---", ""].join("\n");
  const fmFolded = parseFrontmatter(folded);
  assert.equal(fmFolded.fields.description, "第一行 第二行");
});

test("frontmatter：缺 name / 未闭合 / 无 frontmatter 都要报出来", () => {
  assert.match(parseFrontmatter("# 没有 frontmatter").problems.join(), /没有 frontmatter/);
  assert.match(parseFrontmatter("---\nname: a\n").problems.join(), /未闭合/);
  assert.match(parseFrontmatter("").problems.join(), /文件为空/);
});

test("技能扫描：name 与目录名不一致是**警告**不是坏（宿主以 name 为身份）", () => {
  const ctx = makeSkillRoot();
  try {
    writeSkill(
      ctx.root,
      "react-three-fiber",
      ["---", "name: threejs-scene-builder", "description: 造三维场景", "---", "正文"].join("\n")
    );
    const scanned = scanSkillRoot(ctx.root, { source: "user-agents", rank: 500, scope: "user" });
    assert.equal(scanned.broken.length, 0, "不一致不该判为坏");
    assert.equal(scanned.skills.length, 1);
    // 身份取 frontmatter 的 name；dirName 另存，好让人知道文件在哪
    assert.equal(scanned.skills[0].name, "threejs-scene-builder");
    assert.equal(scanned.skills[0].dirName, "react-three-fiber");
    assert.equal(scanned.skills[0].warnings[0].kind, "name-mismatch");
  } finally {
    ctx.cleanup();
  }
});

test("技能扫描：description 超展示上限是**警告**，技能仍留在列表里", () => {
  const ctx = makeSkillRoot();
  try {
    const long = "x".repeat(600);
    writeSkill(ctx.root, "long-desc", ["---", "name: long-desc", `description: ${long}`, "---", ""].join("\n"));
    const scanned = scanSkillRoot(ctx.root, { source: "user-agents", rank: 500, scope: "user" });
    assert.equal(scanned.broken.length, 0, "超长不该判为坏");
    assert.equal(scanned.skills.length, 1, "技能必须留在列表里");
    assert.equal(scanned.skills[0].descriptionLength, 600);
    assert.equal(scanned.skills[0].warnings[0].kind, "description-too-long");
  } finally {
    ctx.cleanup();
  }
});

test("技能扫描：真·不可加载的三种情况进 broken", () => {
  const ctx = makeSkillRoot();
  try {
    // ① 缺 description —— 宿主不会加载
    writeSkill(ctx.root, "no-desc", ["---", "name: no-desc", "---", ""].join("\n"));
    // ② 缺 name —— 宿主不会加载
    writeSkill(ctx.root, "no-name", ["---", "description: 有描述没名字", "---", ""].join("\n"));
    // ③ 名字不是 kebab-case
    writeSkill(ctx.root, "Bad_Name", ["---", "name: Bad_Name", "description: 大写不行", "---", ""].join("\n"));
    // ④ 目录里根本没有 SKILL.md
    mkdirSync(join(ctx.root, "empty-dir"), { recursive: true });
    // ⑤ 一个好的，证明坏的不影响好的
    writeSkill(ctx.root, "good-one", ["---", "name: good-one", "description: 正常技能", "---", ""].join("\n"));

    const scanned = scanSkillRoot(ctx.root, { source: "user-agents", rank: 500, scope: "user" });
    assert.equal(scanned.skills.length, 1);
    assert.equal(scanned.skills[0].name, "good-one");
    assert.equal(scanned.broken.length, 4);
    const details = scanned.broken.map((b) => `${b.file}:${b.detail}`).join(" | ");
    assert.match(details, /no-desc:.*没有 description/);
    assert.match(details, /no-name:.*没有 name/);
    assert.match(details, /Bad_Name:.*kebab-case/);
    assert.match(details, /empty-dir:.*没有 SKILL.md/);
  } finally {
    ctx.cleanup();
  }
});

test("技能扫描：符号链接指向的技能目录必须被扫到（Dirent 对 symlink 两个 is* 都是 false）", () => {
  const ctx = makeSkillRoot();
  const outside = mkdtempSync(join(tmpdir(), "mneme-cap-link-target-"));
  try {
    // 真实技能放在别处，根目录里只放一个链接——实测本机某个用户级技能根里就是这种
    // 形态（一个链接进来的技能），一度 8 个目录只扫出 7 个且既不报错也不进 broken。
    mkdirSync(join(outside, "linked-skill"), { recursive: true });
    writeFileSync(
      join(outside, "linked-skill", "SKILL.md"),
      ["---", "name: linked-skill", "description: 我是链接进来的", "---", ""].join("\n"),
      "utf8"
    );
    try {
      symlinkSync(join(outside, "linked-skill"), join(ctx.root, "linked-skill"), "junction");
    } catch (error) {
      // Windows 无权限时跳过，而不是让整条用例假绿
      if (error.code === "EPERM" || error.code === "EACCES") return;
      throw error;
    }

    const scanned = scanSkillRoot(ctx.root, { source: "user-dsh", rank: 400, scope: "user" });
    assert.equal(scanned.broken.length, 0, "链接不该被判为坏");
    assert.equal(scanned.skills.length, 1, "链接进来的技能必须出现在列表里（不许静默消失）");
    assert.equal(scanned.skills[0].name, "linked-skill");
    assert.equal(scanned.skills[0].viaSymlink, true, "要标出它是链接进来的（改它等于改那边）");
  } finally {
    ctx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("技能扫描：悬空符号链接要报出来，不许静默跳过", () => {
  const ctx = makeSkillRoot();
  try {
    try {
      symlinkSync(join(ctx.root, "no-such-target-at-all"), join(ctx.root, "dangling"), "junction");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") return;
      throw error;
    }
    const scanned = scanSkillRoot(ctx.root, { source: "user-dsh", rank: 400, scope: "user" });
    assert.equal(scanned.skills.length, 0);
    assert.equal(scanned.broken.length, 1, "悬空链接必须进 broken，不能消失");
    assert.match(scanned.broken[0].detail, /符号链接目标不可达|没有 SKILL\.md/);
  } finally {
    ctx.cleanup();
  }
});

test("cordis.patch.yml：嵌套列表项**不得**被当成顶层条目", () => {
  // 实测回归：本机 cordis.patch.yml 顶层只有 30 个 `- ` 条目，但 `allowedModels:`
  // 这类嵌套列表下也写着自己的 - id / name，最初一律当成新条目，把 30 条数成 69 条。
  // 夹具刻意用「嵌套列表」而不是嵌套映射——映射那种情况原用例已覆盖，列表才是漏网的。
  const text = [
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "  config:",
    "    providers:",
    "      volcano-engine:",
    "        allowedModels:",
    "          - id: deepseek-v4-flash",
    "            name: Deepseek-v4 Flash",
    "          - id: glm-5.3-flash",
    "            name: GLM-5.3 Flash",
    "- id: ui-theme",
    "  disabled: false"
  ].join("\n");
  const { entries } = parsePatchEntries(text);
  assert.equal(entries.length, 2, "嵌套列表里的 - id 不是顶层条目");
  assert.equal(entries[0].id, "llm-pi-ai");
  assert.equal(entries[0].name, "@deepseek-ai/dsh-llm-pi-ai");
  assert.equal(entries[1].id, "ui-theme");
  assert.equal(entries[1].disabled, false);
  // 嵌套列表里的 id 不许冒上来
  assert.ok(!entries.some((e) => e.id === "deepseek-v4-flash"), "嵌套的模型 id 不许变成补丁条目");
});

test("技能根：custom 目录要支持，且排在 user 之前（rank 300 < 400）", () => {
  // 宿主 roots() 有 7 个 rank（100/200/250 runtime/300 custom/400/500/600 bundled），
  // 本模块覆盖其中有目录的五类。custom 最容易漏——它来自用户配置而非固定路径。
  const roots = skillRoots({
    projectRoot: "D:/some/project",
    dshHome: "D:/x/.dsh",
    agentsHome: "D:/x/.agents",
    customSkillDirs: ["D:/my/skills", "D:/other/skills"]
  });
  assert.deepEqual(
    roots.map((r) => `${r.source}:${r.rank}`),
    ["project-dsh:100", "project-agents:200", "custom:300", "custom:300", "user-dsh:400", "user-agents:500"]
  );
  // 空串与空白要滤掉，否则会去读一个没意义的目录。过滤发生在 resolveContext
  // （skillRoots 是纯函数，不做清洗）——所以这里走 resolveContext 再传进去。
  const ctx = resolveContext({ dshHome: "D:/x", agentsHome: "D:/y", customSkillDirs: ["", "  ", "D:/ok"] });
  assert.deepEqual(ctx.customSkillDirs, ["D:/ok"], "空白自定义目录必须在入口被滤掉");
  const cleaned = skillRoots(ctx);
  assert.equal(cleaned.filter((r) => r.source === "custom").length, 1);
});

test("总入口：runtime / bundled 两类要如实报「未覆盖」，不能让人以为清单是全的", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-uncovered-"));
  try {
    const r = discoverCapabilities({
      projectRoot: null,
      dshHome: join(base, "none"),
      agentsHome: join(base, "none"),
      profileDir: join(base, "none")
    });
    // 宿主 roots() 里有 7 个 rank，本模块只覆盖有目录的五类——差的这两个要说出来
    const uncovered = r.uncoveredSkillSources.map((u) => u.source).sort();
    assert.deepEqual(uncovered, ["bundled", "runtime"]);
    for (const u of r.uncoveredSkillSources) {
      assert.ok(u.why.length > 0, "每个未覆盖来源都要写清为什么");
      assert.equal(typeof u.rank, "number");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("总入口：每条技能的 origin.dir 与每个 source 的 dir 都必须有值（不许 undefined）", () => {
  // 实测回归：scanSkillRoot 返回的键是 `root`，而下游读的是 `r.dir`——两者不一致时
  // **175 条技能的 origin.dir 全是 undefined 且不报任何错**（位置丢了，别的字段照常）。
  // 这种「静默丢字段」不会让任何现有用例变红，所以单独钉一条。
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-dir-"));
  try {
    const projectRoot = join(base, "proj");
    const dshHome = join(base, ".dsh");
    const agentsHome = join(base, ".agents");
    mkdirSync(projectRoot, { recursive: true });
    writeSkill(join(projectRoot, ".agents", "skills"), "one-skill", [
      "---",
      "name: one-skill",
      "description: 用来检查 dir 字段",
      "---",
      ""
    ].join("\n"));
    // 再放一个坏的，检查 brokenSkills[].dir 也有值
    mkdirSync(join(agentsHome, "skills", "no-skill-md"), { recursive: true });

    const r = discoverCapabilities({ projectRoot, dshHome, agentsHome, profileDir: join(base, "none") });

    assert.equal(r.skills.length, 1);
    for (const s of r.skills) {
      assert.equal(typeof s.origin.dir, "string", `${s.name} 的 origin.dir 必须是字符串`);
      assert.ok(s.origin.dir.length > 0, `${s.name} 的 origin.dir 不能是空串`);
      // 而且必须真的是它所在的那个根
      assert.ok(s.origin.dir.includes(".agents"), "origin.dir 应指向技能所在的根目录");
    }
    for (const src of r.sources) {
      assert.equal(typeof src.dir, "string", `source ${src.source} 的 dir 必须是字符串`);
      assert.ok(src.dir.length > 0, `source ${src.source} 的 dir 不能是空串`);
    }
    assert.equal(r.brokenSkills.length, 1);
    for (const b of r.brokenSkills) {
      assert.equal(typeof b.dir, "string", "brokenSkills[].dir 必须是字符串");
      assert.ok(b.dir.length > 0, "brokenSkills[].dir 不能是空串");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("技能根：没有项目根时**不得**造出项目级根（不许回退到进程 cwd）", () => {
  // 这里只需一个「像项目根」的路径，不必是本机真实路径——用常量避免把机器信息写进仓库。
  const PROJECT = "D:/some/project";
  const withProject = skillRoots({ projectRoot: PROJECT, dshHome: "D:/x/.dsh", agentsHome: "D:/x/.agents" });
  const sources = withProject.map((r) => r.source);
  assert.deepEqual(sources, ["project-dsh", "project-agents", "user-dsh", "user-agents"]);
  // rank 升序 = 优先级顺序，抄的是宿主的数
  assert.deepEqual(withProject.map((r) => r.rank), [100, 200, 400, 500]);

  const noProject = skillRoots({ projectRoot: null, dshHome: "D:/x/.dsh", agentsHome: "D:/x/.agents" });
  assert.deepEqual(noProject.map((r) => r.source), ["user-dsh", "user-agents"], "没有项目根就只能有用户级根");
});

test("技能根：projectRoot 为空串或空白视同没有项目根", () => {
  const ctx = resolveContext({ projectRoot: "   " });
  assert.equal(ctx.projectRoot, null, "空白项目根必须归一成 null，否则会去读 './.agents/skills'");
});

test("cordis.patch.yml：只认顶层 id/name/disabled，嵌套 config 不进去", () => {
  const text = [
    "# 注释行不该被当成条目",
    "- id: mnemon-bundle",
    "  disabled: true",
    "- id: ui-theme",
    "  name: '@deepseek-ai/dsh-client-ui-theme'",
    "  config:",
    "    preference: dark",
    "    nested:",
    "      deeper: 1",
    "- id: agent-default-model",
    "  config:",
    "    provider: workbuddy-xdpool",
    "    model: deepseek-v4.1-flash",
    "  disabled: false",
    // 顶层非 `- ` 行：真格式错，要报出来。放在最后，避免落进上一个条目的嵌套块范围
    // （那种跟随行本来就该被当成上一个条目的内容，不算格式错）
    "not-an-entry: true"
  ].join("\n");
  const { entries, problems } = parsePatchEntries(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { id: "mnemon-bundle", name: null, disabled: true });
  assert.equal(entries[1].name, "@deepseek-ai/dsh-client-ui-theme");
  assert.equal(entries[1].disabled, null, "没写 disabled 就是 null（未声明），不是 false");
  // 关键：disabled 出现在嵌套 config **之后**，仍必须认出来
  assert.equal(entries[2].disabled, false, "config 之后写的 disabled 也要认");
  // 嵌套 config 里的键不能被误读成顶层字段
  assert.equal(entries[2].name, null, "config 里的 provider/model 不该冒上来");
  assert.equal(entries[2].id, "agent-default-model", "config 不该盖掉 id");
  // 不认识的顶层键要说出来，不能静默忽略（格式一变就悄悄读错是最坏的一种错）
  assert.match(problems.join(), /未识别的顶层键「not-an-entry」/);
});

test("总入口：三类都读不到时如实报 absent，不抛错也不编造", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-empty-"));
  try {
    const r = discoverCapabilities({
      projectRoot: null,
      dshHome: join(base, "no-such-dsh"),
      agentsHome: join(base, "no-such-agents"),
      profileDir: join(base, "no-such-profile")
    });
    assert.equal(r.contract, "mneme.capability/v1");
    assert.equal(r.counts.skills, 0);
    assert.equal(r.counts.mcpCatalog, 0);
    assert.equal(r.counts.pluginBundles, 0);
    // 根不存在是「absent」，不是错误
    for (const s of r.sources) assert.equal(s.present, false);
    // MCP 与插件的运行时部分要说清「拿不到，得问宿主」，而不是留空
    assert.match(r.mcp.runtimeOnly.why, /ctx\.tools/);
    assert.match(r.plugins.runtimeOnly.why, /Loader/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("总入口：技能同名时项目级压住用户级，且被压住的记进 shadowed", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-shadow-"));
  try {
    const projectRoot = join(base, "proj");
    const dshHome = join(base, ".dsh");
    const agentsHome = join(base, ".agents");
    mkdirSync(projectRoot, { recursive: true });

    // 两个根里都有同名技能，内容不同
    writeSkill(join(projectRoot, ".agents", "skills"), "same-name", [
      "---",
      "name: same-name",
      "description: 我来自项目级",
      "---",
      ""
    ].join("\n"));
    writeSkill(join(agentsHome, "skills"), "same-name", [
      "---",
      "name: same-name",
      "description: 我来自用户级",
      "---",
      ""
    ].join("\n"));
    // 只有一个用户级才有的技能，证明它不该被埋掉
    writeSkill(join(agentsHome, "skills"), "only-user", ["---", "name: only-user", "description: 只有用户级有", "---", ""].join("\n"));

    const r = discoverCapabilities({ projectRoot, dshHome, agentsHome, profileDir: join(base, "none") });
    assert.equal(r.counts.skills, 2);
    const same = r.skills.find((s) => s.name === "same-name");
    assert.equal(same.summary, "我来自项目级", "同名时项目级（rank 200）必须赢");
    assert.equal(same.origin.source, "project-agents");
    assert.ok(r.skills.find((s) => s.name === "only-user"), "不重名的用户级技能必须保留");
    assert.equal(r.shadowed.length, 1);
    assert.equal(r.shadowed[0].hidden, "user-agents");
    assert.equal(r.shadowed[0].by, "project-agents");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("总入口：MCP 目录与连接是两件事，catalog 不算「已连接」", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-mcp-"));
  try {
    const dshHome = join(base, ".dsh");
    mkdirSync(join(dshHome, "storages"), { recursive: true });
    writeFileSync(
      join(dshHome, "storages", "mcp_connector.json"),
      JSON.stringify({
        unit: { name: "mcp_connector", version: 1 },
        tables: {
          // 目录里有 2 条，但一条都没连
          catalog: {
            remote: {
              connectors: [
                { id: "a", name: "甲", vendor: "V", category: "C", summary: "s", servers: [{ url: "https://secret.example/mcp" }], auth: { mode: "none" }, probeStatus: "pass" },
                { id: "b", name: "乙", servers: [], auth: { mode: "oauth" }, probeStatus: "fail" }
              ]
            }
          },
          connections: {},
          grants: {}
        }
      }),
      "utf8"
    );
    const r = discoverCapabilities({ projectRoot: null, dshHome, agentsHome: join(base, "none"), profileDir: join(base, "none") });
    assert.equal(r.counts.mcpCatalog, 2);
    assert.equal(r.counts.mcpConnections, 0);
    assert.equal(r.mcp.connections.length, 0, "connections 为空就是空，不许拿 catalog 顶替");
    // catalog 条目标 catalog 可见性，不是 declared / read
    assert.equal(r.mcp.catalog[0].visibility, "catalog");
    // 私有端点 URL 不进清单（清单会被截图）
    const serialized = JSON.stringify(r.mcp.catalog);
    assert.ok(!serialized.includes("secret.example"), "servers 里的 url 不该被输出");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("总入口：插件 bundles 与 patch 分开报，disabled 的能数出来", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-plug-"));
  try {
    const profileDir = join(base, "profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-study-desk"] } } }),
      "utf8"
    );
    writeFileSync(
      join(profileDir, "cordis.patch.yml"),
      ["- id: mnemon", "  disabled: true", "- id: ui-theme", "  name: '@deepseek-ai/dsh-client-ui-theme'"].join("\n"),
      "utf8"
    );
    const r = discoverCapabilities({ projectRoot: null, dshHome: join(base, "none"), agentsHome: join(base, "none"), profileDir });
    assert.equal(r.counts.pluginBundles, 2);
    assert.equal(r.counts.pluginPatches, 2);
    assert.equal(r.plugins.patches.filter((p) => p.disabled === true).length, 1);
    // 声明不等于生效：两类都标 declared，运行时状态单列
    assert.equal(r.plugins.bundles[0].visibility, "declared");
    assert.match(r.plugins.runtimeOnly.what, /真实加载结果/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("MCP 使用记录要按 serverName 匹配，不是按 catalog 的 id（CodeRabbit 抓到的映射缺陷）", () => {
  // 实测回归：会话日志里的 MCP 工具名是 mcp__<serverName>__<tool>，而 serverName 与
  // catalog 的 `id` **不保证相同**——本机 109 条里有 41 条不一致（如
  // id=baidu-maps ↔ serverName=baidu-map；id=polardb ↔ serverName=polardbx）。
  // 早期只按 id 匹配，那些 server 的真实调用会被显示成 candidate（用过却看着没用过）。
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-mcpname-"));
  try {
    const dshHome = join(base, ".dsh");
    mkdirSync(join(dshHome, "storages"), { recursive: true });
    writeFileSync(
      join(dshHome, "storages", "mcp_connector.json"),
      JSON.stringify({
        unit: { name: "mcp_connector", version: 1 },
        tables: {
          catalog: {
            remote: {
              connectors: [
                // id 与 serverName 故意不一致——这正是要钉住的情形
                { id: "baidu-maps", name: "百度地图", servers: [{ serverName: "baidu-map" }] },
                // 一个 id 挂多个 serverName
                { id: "pkulaw-legal", name: "北大法宝", servers: [{ serverName: "pkulaw-law-search" }, { serverName: "pkulaw-case-keyword" }] },
                // 一致的普通情形（回归保护）
                { id: "github", name: "GitHub", servers: [{ serverName: "github" }] }
              ]
            }
          },
          connections: {},
          grants: {}
        }
      }),
      "utf8"
    );
    // 会话日志里用的是 serverName（baidu-map），不是 id（baidu-maps）
    const sessionId = "session-mcpname-0001";
    const dir = join(base, "sessions", "work", sessionId);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant/message",
        time: 1792000000000,
        data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "tool-call", name: "mcp__baidu-map__geocode", arguments: "{}" }] } }
      }),
      JSON.stringify({
        type: "assistant/message",
        time: 1792000000001,
        data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "tool-call", name: "mcp__pkulaw-case-keyword__search", arguments: "{}" }] } }
      })
    ].join("\n");
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(lines, "utf8")));

    const r = discoverCapabilities({ projectRoot: null, dshHome, agentsHome: join(base, "none"), profileDir: join(base, "none"), sessionDir: join(base, "sessions") });

    // serverNames 必须被留下来
    const baidu = r.mcp.catalog.find((c) => c.id === "baidu-maps");
    assert.deepEqual(baidu.serverNames, ["baidu-map"], "serverName 要留在 catalog 条目上");

    // 关键：按 serverName 匹配上了 → 不是 candidate
    assert.equal(baidu.usage.state, "trusted", "id 与 serverName 不一致时仍要匹配到使用记录");
    assert.equal(baidu.usage.name, "baidu-map", "usage 记的是 serverName");
    assert.equal(baidu.usage.uses, 1);

    // 一个 id 挂多个 serverName：命中任意一个即可
    const pkulaw = r.mcp.catalog.find((c) => c.id === "pkulaw-legal");
    assert.equal(pkulaw.usage.uses, 1, "多 serverName 时命中其一即可");
    assert.equal(pkulaw.usage.name, "pkulaw-case-keyword");

    // 一致的情形照旧
    const gh = r.mcp.catalog.find((c) => c.id === "github");
    assert.equal(gh.usage.state, "candidate", "没用过的仍是 candidate");
    assert.equal(gh.serverNames[0], "github");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("总入口：坏的 mcp_connector.json 不抛错，如实记 unreadable", () => {
  const base = mkdtempSync(join(tmpdir(), "mneme-cap-badmcp-"));
  try {
    const dshHome = join(base, ".dsh");
    mkdirSync(join(dshHome, "storages"), { recursive: true });
    writeFileSync(join(dshHome, "storages", "mcp_connector.json"), "{ 这不是 JSON", "utf8");
    const r = discoverCapabilities({ projectRoot: null, dshHome, agentsHome: join(base, "none"), profileDir: join(base, "none") });
    assert.equal(r.counts.mcpCatalog, 0);
    assert.match(String(r.mcp.unreadable), /JSON 解析失败/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
