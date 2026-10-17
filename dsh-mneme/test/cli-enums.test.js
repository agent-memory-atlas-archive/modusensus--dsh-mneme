// CLI 枚举是手写字面量（bin/cli.mjs 是零依赖 HTTP 客户端，不 import 服务端
// 模块），没有类型系统兜着，所以用一张文本锁把它钉在 store.TYPES 上。
// 防的回归：2026-10 审计发现 MEMORY_TYPES 只有 5 个类型、SEARCH_MODES 缺
// hybrid，结果是 add --type pitfall 与 search --mode hybrid 被客户端自己拒掉
// ——服务端明明支持，客户端先说不。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TYPES } from "../src/store.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = readFileSync(path.join(root, "bin", "cli.mjs"), "utf8");

function literalArray(name) {
  const m = cli.match(new RegExp("const " + name + " = \\[([^\\]]*)\\]"));
  assert.ok(m, name + " 应从 bin/cli.mjs 里解析出来（改名就同步改这把锁）");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test("cli MEMORY_TYPES 与 store.TYPES 的差值恰好是 document", () => {
  const cliTypes = literalArray("MEMORY_TYPES");
  // document 只能经 memory_register_document 铸造；放进 --type 会让用户得到一条
  // 服务端 400。锁「差值恰好是 document」而不是「完全相等」，就是为了让这条
  // 例外显式化：未来再加一个只能经专用接口铸造的类型，这里会红。
  const expected = [...TYPES].filter((t) => t !== "document").sort();
  assert.deepEqual(cliTypes.slice().sort(), expected);
});

test("cli SEARCH_MODES 覆盖 API 支持的全部召回模式", () => {
  const modes = literalArray("SEARCH_MODES");
  // 四种模式来自 src/api.js 的 /search mode 注释（auto/hybrid/vector/keyword）。
  for (const mode of ["keyword", "vector", "auto", "hybrid"]) {
    assert.ok(modes.includes(mode), "SEARCH_MODES 缺少 " + mode);
  }
});
