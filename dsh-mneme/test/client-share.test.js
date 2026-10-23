// 车道 D 的面板静态锁。为什么是静态锁：lib/client.js 由宿主 __ModuleLoader__ 加载，
// 本仓库没有可跑的宿主壳，渲染测试要拖进一份 React 测试栈才够得着那几行真代码。
// 锁的是「形状」而不是「长得像」：每一条都对应一个**会伤人的回归形态**，
// 注释里写清它防的是哪一种（AGENTS.md 纪律 8 对测试同样适用）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib/client.js"), "utf8");
const shareSource = readFileSync(join(here, "..", "src/share.js"), "utf8");

// 分享弹层最要紧的一条：**看见 report 之前不给下载**（spec §6 的支点）。
// 防的回归形态：有人为了「方便」把下载按钮改成常驻，或从别处（如列表工具栏）再开一条
// 直接落盘的口子——那一步停顿就没了，随手全库外发重新变成一次点击。
test("the share dialog gates the download on the report", () => {
  assert.ok(clientSource.includes('apiFetch("/api/dsh-mneme/share"'),
    "面板必须发这一枪（不许另造 fetch 绕过 apiFetch 的 token 注入）");
  assert.ok(clientSource.includes("const canDownload = !!rep && rep.included > 0;"),
    "下载按钮的唯一门：有报告且有内容。included 为 0 时对面吃的是 empty-pack（400），不该给一个必败的文件");
  assert.ok(clientSource.includes("canDownload && h(\"div\""),
    "下载那一行必须挂在 canDownload 上，而不是常驻（按钮本身在这样一个 div 里）");
  // 413 与 200 是两份形状：413 没有 memories，只有 report + 字节数 + hint。
  assert.ok(clientSource.includes("if (res.status === 413)"),
    "超水位要走 tooLarge 那一支，不能落到通用失败");
  assert.ok(clientSource.includes("JSON.stringify(pack, null, 2)"),
    "落盘的必须是服务端给的那份包，不能在面板里重拼字段（重拼一次就是一份第二口径）");
});

// docs/SHARE.md「车道 D 三笔账」之一：included 只数实际发出的条数，够格进包的是
// included + deduped。防的回归：有人把「合格条数」的标签挪到 included 上，读数是假的。
test("the report separates what shipped from what qualified", () => {
  assert.ok(clientSource.includes("report.included + report.deduped"),
    "折叠掉的那几条必须加回去，两个数同屏");
  assert.ok(clientSource.includes('"memory.explorer.shareDeduped"'),
    "deduped 有自己的一行文案，不是并进 included 那句");
});

// 跨文件锁：面板的六个跳过原因与八个可分享类型都只许是服务端那份的投影。
// 防的回归：share.js 加/改一个 reason 键或一类可分享类型，面板静默少一格
// ——她的报告上就有一类跳过是看不见的。
test("the panel's skip-reason and type sets mirror src/share.js", () => {
  const serverReasons = [...shareSource.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const uniqueReasons = [...new Set(serverReasons)];
  const panelReasons = /const SHARE_SKIP_REASONS = \[([^\]]*)\]/.exec(clientSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual(panelReasons, uniqueReasons,
    "跳过原因集必须与 share.js 的判序一致（顺序也一致：报告按判序展示）");

  const serverTypes = /SHARE_ALLOWED_TYPES = new Set\(\[([^\]]*)\]/.exec(shareSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  const panelTypes = /const SHARE_TYPE_OPTIONS = \[([^\]]*)\]/.exec(clientSource)[1]
    .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual(panelTypes.slice().sort(), serverTypes.slice().sort(),
    "类型下拉只能列真能进包的那几类");
});

// 别名的尺：服务端 importedTagFor 把整串（含 from-）截到 IMPORTED_TAG_MAX。
// 防的回归：服务端改这个常量而面板还拦着旧长度，她打的字在对面被静默吃掉。
test("the alias input matches the server's tag budget", () => {
  const max = Number(/IMPORTED_TAG_MAX = (\d+)/.exec(shareSource)[1]);
  assert.ok(clientSource.includes(`maxLength: ${max - "from-".length}`),
    "输入框长度必须等于服务端留给别名的字符数");
});

// 文件名以服务端 Content-Disposition 为准（拼法只住在 src/share-http.js 的 shareFilename）。
// 防的回归：面板自己抄一份「日期 + pack_id 前 8 位」的拼法，两处日后分叉。
test("the pack filename comes from the response header, with a pack_id fallback", () => {
  assert.ok(clientSource.includes('res.headers.get("content-disposition")'));
  assert.ok(clientSource.includes("const dispositionName = (value) =>"));
  // 回落那一格只许出现一次前缀串，且不带日期拼法。
  assert.equal(clientSource.split("dsh-mneme-share-").length - 1, 1,
    "面板只许有一份包名前缀串（回落用），不许再拼第二套日期命名");
  assert.equal(clientSource.includes("slice(0, 8)"), false,
    "pack_id 截 8 位是服务端的拼法，面板不许复制");
});
