// 工作流配置的回归锁：安全扫描与发布权限的姿态不能悄悄退回。
// 这两条锁的都是「配置漂移」——CI 配置没有类型检查，改错了照样绿。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test("security.yml 的 osv-scanner 保持 fail-on-vuln: true", () => {
  // 2026-10 审计：这里原本是 false（纯提醒，PR 上永远是绿的）。改回 false 就等于
  // 「有已知漏洞也不红」，而测试目录原本没有任何东西会察觉这件事。
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "security.yml"), "utf8");
  assert.match(yml, /fail-on-vuln:\s*true/, "osv-scanner 必须保持 fail-on-vuln: true");
  assert.doesNotMatch(yml, /fail-on-vuln:\s*false/, "不得退回只上传 SARIF 不拦的档位");
});

// 剥掉整行注释再断言：注释里会**描述**「id-token: write 该发给谁」，
// 直接对全文 grep 会被自己写的说明文字骗过（第一版就栽在这里）。
function codeOnly(yml) {
  return yml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
}

// 按缩进切出单个 job 的文本块：工作流顶层是 0 缩进，job 名是 2 缩进。
// 只做文本切片不做完整 YAML 解析——仓库零依赖，为一条断言引 yaml 解析器不划算。
function jobBlock(yml, name) {
  const lines = codeOnly(yml).split(/\r?\n/);
  const start = lines.findIndex((l) => l === "  " + name + ":");
  assert.ok(start >= 0, "找不到 job: " + name);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("release.yml 的 provenance 权限只发给 publish，不发给工作流顶层", () => {
  // 三件事分开断言，因为「全文件 grep id-token: write」会被两种错误都骗过：
  //   ①有人把 id-token 提到工作流顶层（verify/test 也拿到 OIDC 能力）
  //   ②有人把 publish 的权限删了但别的 job 还有（provenance 会失败）
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /npm publish[^\n]*--provenance/, "publish 必须带 --provenance");

  // YAML 允许把顶层键写成 "jobs": 或 'jobs':，那也是合法的工作流。
  // 只匹配裸 jobs: 会在那种写法下把整个文件当成 head，于是 publish 里合法的
  // id-token 被误判成「顶层声明」——失败方向是误红不是漏检，但假红会磨损这条锁。
  const head = codeOnly(yml).split(/\r?\n(?=["']?jobs["']?:\s*$)/m)[0];
  assert.doesNotMatch(head, /id-token:/, "工作流顶层不得声明 id-token（会泄漏给所有 job）");

  const publish = jobBlock(yml, "publish");
  assert.match(publish, /id-token:\s*write/, "publish job 需要 id-token: write");
  assert.doesNotMatch(publish, /contents:\s*write/, "publish 只读代码，不需要 contents: write");

  const release = jobBlock(yml, "release");
  assert.match(release, /contents:\s*write/, "release job 建 Release 需要 contents: write");
});
