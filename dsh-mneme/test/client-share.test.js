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
  assert.ok(clientSource.includes('t("memory.explorer.shareDeduped")'),
    "deduped 那一行要真的有渲染点，不是只在字典里躺着");
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
  assert.equal(/pack_id[^;\n]{0,48}slice\(\s*0\s*,\s*8\s*\)/.test(clientSource), false,
    "不许在 pack_id 后面截 8 位——那是 src/share-http.js 的 shareFilename 唯一的拼法");
});

// docs/SHARE.md「车道 D 三笔账」之二：干跑与真导入的答复同形状，区别只有
// withDryRun 加的 dry_run 那一格。防的回归形态：界面按「我有没有发 confirm」推断写了
// 没有——同一件事写两处，改一处就出现「其实没写、却说写了」。
test("the receive dialog reads dry_run instead of inferring from its own button", () => {
  assert.ok(clientSource.includes('apiFetch("/api/dsh-mneme/receive"'),
    "入库只许走这一枪（apiFetch 带 token 注入）");
  assert.ok(clientSource.includes("post({ pack })"), "预览那一发不带 confirm——缺省即干跑");
  assert.ok(clientSource.includes("post({ pack, confirm: true })"),
    "真写的那一发必须带 confirm 这个真值，其他形状服务端都不认");
  assert.ok(clientSource.includes('d.dry_run === false ? "memory.explorer.receiveDidCreate"'),
    "「写进去了」这句只能由答复自己说——钉的是那个三元式本身，不是六个字面量都在");
  assert.ok(clientSource.includes("result.dry_run !== false"),
    "确认之后仍回干跑时要单独说「没有写库」，不许沉默，也不许挂在预览那一支上");
  assert.ok(clientSource.includes('"memory.explorer.receiveStillDry"'),
    "那一格要有自己的文案");
  // 第二个旋钮一概不认：收侧只认 confirm（spec §5——reclaim 的 body 里就带 dryRun，
  // 手熟的人会顺手发来，把它读成「要写」等于替她点头）。
  // **切片而不是全文**：本文件里 reclaim/VACUUM 那一发合法地发 `dryRun: false, confirm: true`，
  // 那是 reclaim 的形状不是 receive 的。全文反锁会一上来就红；谁把它「修」成全文锁，
  // 就等于给 reclaim 那颗键定罪。所以按函数名切区段，并且**两个锚点都要验**：
  // 结束锚点丢了的时候 indexOf 返回 -1，切片会一路长到文件尾而不是塌成空——
  // 那时候这条锁看似更严，实际悄悄开始管整个文件（而 ReceiveDialog 之后今天没有 dryRun，
  // 它会空过）。两头都钉住，锚点漂移只会红得明白。
  const receiveStart = clientSource.indexOf("function ReceiveDialog(");
  const receiveEnd = clientSource.indexOf("// #386 第 5 条", receiveStart);
  assert.ok(receiveStart > 0 && receiveEnd > receiveStart,
    "ReceiveDialog 的起止锚点都要在，且顺序对——否则这条锁在管的东西和它说的不是一件");
  const receiveRegion = clientSource.slice(receiveStart, receiveEnd);
  assert.ok(receiveRegion.length > 800, "ReceiveDialog 的区段短得不像话，先修锚再谈锁");
  assert.equal(receiveRegion.includes("dryRun"), false,
    "收侧不许发 dryRun——唯一的入口是 confirm");
});

// 三笔账之三：title_conflicts 是 advisory 读数，只对「本轮真正会新建的那些」判过，
// 重吃同一个包时恒空。防的回归：文案写成「现在没有冲突」。
test("the receive preview keeps the advisory reading honest", () => {
  assert.ok(clientSource.includes("d.title_conflicts"), "撞名清单要显示");
  assert.ok(clientSource.includes('"memory.explorer.receiveConflicts"'));
  // 钉的是**文案**而不是注释：解释性的话必须能写「这不等于没有冲突」来提醒读者，
  // 连注释一起 ban 等于把警告本身禁掉（这一轮就撞上了：新注释里的「没有撞名」先红的是这条锁）。
  // 真正会伤人的是屏上那一句，所以只扫非注释行。
  const copyLines = clientSource.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  assert.equal(/现在没有冲突|没有撞名|无冲突|no conflicts|no title clashes/i.test(copyLines), false,
    "不许出现「没有冲突」这类绝对断言（清单为空只说明本轮没有新的要报）");
  // 先预览才允许确认：干跑是必经的一站，不是可选装饰。
  assert.ok(clientSource.includes("disabled: busy || !preview"),
    "确认按钮在拿到预览之前必须 disabled");
  // advisory 读数的分母要说出来，否则「清单为空」与「什么也没比」在屏上长一个样。
  // 注意它是**包内条数**而不是「比过了几条」，所以文案只许说「包内 N 条」。
  assert.ok(clientSource.includes("d.conflicts_checked"),
    "要把服务端给的包内条数显示出来");
  assert.ok(clientSource.includes('t("memory.explorer.receivePackCount")'),
    "那一行要有自己的渲染点，不是只在字典里躺着");
});

// D3 评审裁定补的锁：两种「按了没反应」的形态。
//   a) 200 但正文读不出——曾经一路 return null，调用方把它读成「屏上已有提示」，
//      于是确认那一发悄悄没走完，而上一块的「将新建 N 条」还留在屏上；
//   b) 预览还在飞的时候又能选一个文件——飞回来的数字说的是前一个包，确认写的却是后一个。
test("the receive dialog never goes silent, and never lets a superseded preview drive the write", () => {
  assert.ok(clientSource.includes('if (!d || typeof d !== "object") {'),
    "200 但没有可读正文也要 setErr，不许 return null 装成「已经处理过了」");
  assert.ok(clientSource.includes("disabled: busy, onClick: () => fileRef.current?.click()"),
    "预览/确认在飞的时候不许再选文件（那一块数字属于上一个包）");
  assert.ok(clientSource.includes('typeof parsed !== "object"'),
    "解得出 JSON 但不是对象，是另一种失败，得有它自己的一句话");
  assert.ok(clientSource.includes('e.target.value = ""'),
    "选完清空控件值：否则改过的同一个文件再选一次不发 change，面板拿着旧包预览");
});
