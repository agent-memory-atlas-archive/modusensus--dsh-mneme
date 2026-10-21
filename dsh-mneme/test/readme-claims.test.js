// 两份 README 曾经都写着「默认全离线」「offline by default」「默认零网络依赖」——
// 这与代码默认值相反：autoDream 与 autoSummarize 默认开（src/config.js），
// 两者都把记忆正文交给 ctx.llm.stream(...)（src/dream.js / src/summarize.js）；
// embedProvider 默认还是 "openai"，只有显式改成 "local"（ONNX）才真正离线。
// 一句假话比不写更坏：读者会据此以为装完就能断网用，而它默认会把正文发给宿主模型。
// 所以这里锁两件事：一、绝对离线声明不许回来；二、隐私节必须写出「巩固走宿主模型」这个出站事实——
// 删掉假话后如果什么都不说，误导是一样的。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const rootReadmePath = path.join(repoRoot, "README.md");

// npm 的 files 清单把整个 test/ 打进包里，所以在 packed / installed 包里跑 npm test 时，
// 这个文件照样会被执行——但那里没有仓库根 README（只有包内 dsh-mneme/README.md）。
// 直接 readFileSync 会让整个测试文件在加载阶段 ENOENT 崩掉，把「不是这个仓」报成「断言失败」。
// 所以仓库根不在时显式 skip：这条守卫的适用面本来就只是仓库，不该在包内假红。
const hasRepoRoot = existsSync(rootReadmePath);
const rootReadme = hasRepoRoot ? readFileSync(rootReadmePath, "utf8") : "";
const pkgReadme = readFileSync(path.join(pkgRoot, "README.md"), "utf8");
const outsideRepo = hasRepoRoot ? {} : { skip: "not a repo checkout: 仓库根 README 不存在（包内安装态）" };

// 只锁「默认 / 无条件」的说法。带条件的离线表述（把 embedProvider 改成 local、离线巩固论文、
// 运行时离线取件）都是真话，不在这个列表里，否则守卫会把正确写法也判红。
const ABSOLUTE_CLAIMS = [
  "默认全离线",
  "默认零网络依赖",
  "offline by default",
  "Zero network dependency by default",
  "完全离线的语义记忆引擎",
];

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `README 里应有「${heading}」一节`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\r?\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("两份 README 都不许再把「离线」写成默认行为", outsideRepo, () => {
  for (const [name, text] of [
    ["README.md", rootReadme],
    ["dsh-mneme/README.md", pkgReadme],
  ]) {
    for (const claim of ABSOLUTE_CLAIMS) {
      assert.ok(!text.includes(claim), `${name} 仍含绝对离线声明：${claim}`);
    }
  }
});

test("隐私节必须写出「巩固与摘要走宿主模型」这个出站事实", outsideRepo, () => {
  const zh = section(rootReadme, "## 隐私承诺");
  assert.ok(zh.includes("宿主模型"), "中文隐私节应说明巩固与摘要走宿主模型");
  assert.ok(
    zh.includes("autoDream") || zh.includes("autoSummarize"),
    "中文隐私节应点名 autoDream / autoSummarize，否则读者不知道是谁在出站",
  );
  const en = section(rootReadme, "## Privacy");
  assert.ok(
    en.includes("host model"),
    "English Privacy section should disclose that consolidation uses the host model",
  );
});

// 「模型工具」表是代码的投影，不是愿望清单（AGENTS.md 给 SECURITY.md 定的那条规矩，
// 这张表一直没有）。它已经跑偏两次：#471 加 set_scope_state、#231 加 memory_organize，
// 两次都没人回头改表或改那个数字——因为没人核过。所以这里全部**从代码反推**：
// 工具集从 tools.js 的 name: "…" 取，opt-in 从 hiddenTools 的 `!== true` 判据取
// （`=== true` 那种是「默认在、用户可关」，不能算进 opt-in，否则默认注册数会算少）。
test("包 README 的「模型工具」表与 tools.js 注册表一致", () => {
  const toolsSrc = readFileSync(path.join(pkgRoot, "src/tools.js"), "utf8");
  const declared = [...toolsSrc.matchAll(/^ {6}name: "((?:memory_|set_scope)[a-z_]*)",/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 10, `tools.js 的工具名解析失败（只看到 ${declared.length} 个）——先修这条守卫，别改表`);
  const optIn = [...toolsSrc.matchAll(/if \(config\?\.(\w+) !== true\) hiddenTools\.add\("([a-z_]+)"\)/g)]
    .map((m) => ({ key: m[1], tool: m[2] }));
  const defaultCount = declared.length - optIn.length;

  const heading = pkgReadme.match(/^### 模型工具（([^）]*)）$/m);
  assert.ok(heading, "包 README 应有「### 模型工具（N 个）」这一节标题（标题格式变了就同步改这条守卫）");
  const bodyStart = pkgReadme.indexOf(heading[0]);
  const bodyRest = pkgReadme.slice(bodyStart + heading[0].length);
  const nextSection = bodyRest.search(/\r?\n#{2,3} /);
  const body = nextSection === -1 ? bodyRest : bodyRest.slice(0, nextSection);
  const rows = [...body.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);

  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...new Set(rows)].sort(),
    "表与注册表必须一一对应：少了是漏文档，多了是文档写了不存在的东西"
  );
  assert.equal(rows.length, new Set(rows).size, "表里不许有重复行（重复行会让数量核对失效）");
  for (const n of [defaultCount, declared.length]) {
    assert.ok(heading[1].includes(String(n)), `标题里的数字要含 ${n}（opt-in 工具默认不注册，两个数都要对得上）`);
  }
  // opt-in 工具那一行必须点名它的开关：读者看到表里有它，得知道默认是不出现的。
  for (const { key, tool } of optIn) {
    const row = body.match(new RegExp(`^\\| \`${tool}\` \\|(.*)$`, "m"));
    assert.ok(row, `${tool} 必须在表里`);
    assert.ok(row[1].includes(key), `${tool} 那行要写明它需要 ${key} 才注册`);
  }
});
