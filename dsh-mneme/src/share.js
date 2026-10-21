// 记忆分享包的纯核心：取行口径、脱敏、序列化。
// 本模块不认识 store、不认识 http，也不读 config —— 两侧出口（宿主内面板路由与
// standalone Bearer 数据面）共用的解析与答复在 share-http.js，#411 的教训是这两张皮
// 只许剩鉴权与路径不同。
// 唯一进来的外部判据是两个纯函数（write-admission 的空白/噪声、sensitive-scan 的
// 密钥/PII）：判据只许有一份，所以这里 import 而不是重抄，代价是模块图会连带把
// store 模块**加载**进来（write-admission → service → store）—— 加载不等于使用，
// 本模块不调它任何一个方法，也不碰 config。
import { createHash, randomBytes } from "node:crypto";
import { informationlessReason } from "./write-admission.js";
import { scanSensitive } from "./sensitive-scan.js";

export const SHARE_KIND = "mneme.share/v1";

// 跳过清单的条数上限：面板与 CLI 都要把「为什么这条没进包」摊给人看，但一个
// 几千条的库不该因此产出一份比包还长的报告。超限就截断，计数仍给全量。
export const SHARE_SKIP_LIST_MAX = 50;

// 体积水位留在 3 MiB，上限是两侧 readBody 各自写死的 4 MiB（api.js:55、
// api-standalone.js:29）。留 1 MiB 是给 JSON 包装与接收侧再序列化的余量——
// 包本身要作为 body 原样 POST 回去，水位贴上限等于给自己埋 413。
export const MAX_PACK_BYTES = 3 * 1024 * 1024;

// document 是指针行（#296），正文文件不随包走，导出去对面就是「看着有、点开是空」；
// 与 mirror.js 的 MIRROR_READONLY_TYPES 同口径，但这里刻意写死字面量而不是 import
// 那个 Set —— 分享格式的兼容面比镜像宽，镜像哪天放开只读 type 不该自动改掉包的口径。
export const SHARE_READONLY_TYPES = new Set(["document"]);
export const SHARE_EXCLUDED_TYPES = new Set(["summary"]);

const withoutNul = (value) => String(value ?? "").replace(/\u0000/g, "");

/**
 * 幂等键：NUL 分隔，防 ("ab","c") 与 ("a","bc") 撞同一键。
 *
 * 分隔符只保证「字段之间」的切法唯一，所以入参自己的 U+0000 必须先剥掉：不剥的话
 * ("t","a\0b") 与 ("t\0a","b") 拼出同一串字节，对面重算时把这条当成「已经吃过」，
 * 于是该建的行静默不建（串号是幂等表上最难查的那类 bug，没有报错）。
 * 归一写在这里而不是各调用方：铸造侧（本模块）与重算侧（车道 C）必须共用一份口径，
 * 两份实现各自归一迟早漂。除 U+0000 外不动别的字节，trim 口径照旧 —— 归一规则一变，
 * 已发出去的包里每个 external_id 都对不上。
 */
export function deriveExternalId(packId, type, title) {
  return createHash("sha256")
    .update(`${withoutNul(packId)}\u0000${withoutNul(type)}\u0000${withoutNul(title).trim()}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把正文里的本机 home 前缀换成 `~`。
 *
 * 判据是**分隔符游程**，不是几种固定拼法：把 base 按 `[/\\]+` 切成段，再用 `[/\\]+`
 * 拼回一条正则（段间至少一个分隔符、个数不限）。于是同一目录的所有写法——单反斜杠、
 * 正斜杠、JSON 里转义过的双反斜杠、混合、二次编码——都走同一条判据。上一版按
 * base / 单反斜杠 / 双反斜杠三个固定形态匹配，混合与二次编码照样漏，而「按拼法打补丁」
 * 的失败方式是永远漏下没列到的那一种，漏出来的正是用户名。
 * 大小写不敏感：盘符与用户目录在真实路径里的大小写常常和 homedir() 不一致。
 * 已知代价：段间一个分隔符都没有的写法（`C:Users`）不再命中——那已经不是同一目录的
 * 拼法（Node 与 JSON 都不产它），要命中只能把前缀约束整个拆掉，而那侧错的方向是泄露。
 */
export function createHomeRedactor(homeDir) {
  // 尾分隔符先剥：留着它就成了末段空串，拼出的游程把「正文必须带尾分隔符」写进判据，
  // 没带的那个反而漏。全由分隔符组成的 home（`//`）剥完即空，走 identity 出口——
  // 否则正则会把正文里的斜杠吃成 `~/`，把内容改花。
  const base = (typeof homeDir === "string" ? homeDir.trim() : "").replace(/[/\\]+$/, "");
  if (base.length < 2) return (text) => String(text ?? "");
  const re = new RegExp(`${base.split(/[/\\]+/).map(reEsc).join("[/\\\\]+")}[\\\\/]?`, "gi");
  // 折掉的只有「前缀 + 紧跟着的那一个分隔符」，输出统一成读者与对面 agent 都认的 `~/`；
  // 后面的路径按原样留着——改写用户写下的字节是另一类事故。前缀落在句尾时不补分隔符。
  return (text) => String(text ?? "").replace(re, (m) => (m.endsWith("\\") || m.endsWith("/") ? "~/" : "~"));
}

/**
 * 一条记忆进不进包。顺序是刻意的：先状态位（archived/forgotten），再类型，
 * 再判据 —— 空白与噪声先于敏感判定，因为一条内容为空的记忆没有可泄露的东西，
 * 把它记成 sensitive 会让跳过清单的读数说错原因。
 *
 * 「空白/噪声」这一级不自建判据：复用 informationlessReason（write-admission.js:117），
 * 它的口径是 title+content 的**组合**判定 —— 两侧归一后都不剩字才命中（"blank" 全空、
 * "noise" 只剩标点/空白）。所以标题还有字、正文空白的那条照常进包，这是判据本意，
 * 不是漏网。
 *
 * 跳过的分支也返回脱敏后的 title：跳过清单不只在本机看 —— 打包侧把它原样写进
 * pack.report.skip_list，CLI 再整份打到终端（车道 A3/A7 的口径）。未遮的 title 等于把
 * 用户名装进这份「设计上不含它」的文件，而泄露面最大的恰恰是不进包的那几条。所以在
 * 源头遮，每个消费方拿到的都是安全字符串；下游不需要、也不该再各补一刀。遮的仍是
 * 同一个 redact，本模块只有这一条脱敏路径。
 */
export function classifyRowForShare(row, { redact = (t) => t } = {}) {
  const title = redact(row?.title ?? "");
  if (row?.archived) return { include: false, reason: "archived", title };
  if (row?.forgotten) return { include: false, reason: "forgotten", title };
  if (SHARE_READONLY_TYPES.has(row?.type)) return { include: false, reason: "readonly_type", title };
  if (SHARE_EXCLUDED_TYPES.has(row?.type)) return { include: false, reason: "excluded_type", title };
  if (informationlessReason(row)) return { include: false, reason: "blank_or_noise", title };
  // 扫描面用 `scanSensitive` 这个「任意文本」口径的导出，不用带开关的那个工厂面：
  // 工厂在 sensitiveScanEnabled 关时返回 null（sensitive-scan.js:199），而那个键管的是
  // **写入侧**可观测性。分享边界本身就是安全边界（spec §4）——用户没开写入闸门时
  // 恰恰最需要这里照常在扫，跟着开关走等于裸发整库。
  const scanned = scanSensitive([row?.title, row?.content, ...(Array.isArray(row?.tags) ? row.tags : [])]
    .filter((s) => typeof s === "string").join("\n"));
  if (scanned) return { include: false, reason: "sensitive", title };
  const content = redact(row?.content ?? "");
  return {
    include: true,
    row: {
      type: row.type,
      title,
      content,
      tags: (Array.isArray(row.tags) ? row.tags : []).map((t) => String(redact(t))),
      importance: Number.isInteger(row.importance) ? row.importance : 3,
      epistemic_status: row.epistemic_status ?? "subjective",
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      // 这一条是**发送方库里的内容锚**，原样带过去只作引用，不是完整性凭证，别拿它
      // 校验「正文没在路上被改」（车道 C 注意）。两处对不上：① 它由 store 从**未脱敏**
      // 的 title/content 派生（store.js:1160 → contentHashOf，content-hash.js:49-53），
      // 而包里的 content/title 是遮过的——所以只要 home 遮过一次，两者就必然不一致，
      // 恰恰是遮过的那几条对不上；② 它算的是归一化后的文本（NFKC → 小写 → 去标点 →
      // 空白折叠），对面按收到的字节重算 sha256 本来就得不到同一个值。真要做传输完整性
      // 校验，得对遮后的字节另派一把新字段，不是复用这一把。
      content_hash: row.content_hash ?? null
    }
  };
}

/**
 * 打包。顺序是刻意的：过滤 → 逐条定性 → 铸 external_id → 序列化 → 量字节。
 *
 * 水位量的是**最终序列化字节**，不是条数也不是字符数：这份包要原样当 body POST 回
 * 对面（车道 C），而中文字符数与 UTF-8 字节数差三倍，按字符数判等于把 413 留给对面；
 * 按条数判则对「条少但每条很长」的库说谎，那种包照样过大。字节只能在 JSON 写完之后再量，
 * 所以这里没有「先算大小再决定装几条」的分支。
 *
 * 超限**不裁条目**：裁到哪一条是替分享者做「哪条可以不发」的判断，而这份判断该由她自己
 * 用 filters 分批来做（spec §4 决策 5）。所以只拒绝，并把量到的 bytes 与 limitBytes 一起
 * 交回，让出口能说出「大了多少、怎么分批」。
 *
 * filters 是分享者的显式收窄，**不进跳过计数也不进清单**：那份账要说的是「本可以发、
 * 因为口径没发」，把她自己筛掉的记进去，读数就把她指向错的那一类。
 *
 * skip_list 截到 SHARE_SKIP_LIST_MAX，skipped 的六个计数仍走全量——截的是清单不是账。
 * 清单里的 title 用 classifyRowForShare 返回值原样写入：它已在源头遮过 home，这里补
 * 第二刀是「两个口径」的开始，不是更安全。
 */
export function buildSharePack({
  rows, alias = "", homeDir, packageVersion, filters = {},
  packId = randomBytes(8).toString("hex"), generatedAt = new Date().toISOString()
} = {}) {
  const redact = createHomeRedactor(homeDir);
  // 空数组按「没筛」处理：分享者清空勾选不等于要一个空包，两侧出口（面板 / CLI）传下来的
  // 就是这形态，把它读成「全选」比读成「全不选」更贴近她的意思。
  // 裸字符串同样当一个类型：`--type` 到这儿是数组还是字符串由出口决定，而这里若只认
  // 数组，读不懂的那一侧错的方向是**放行整库**——她以为只发了一类，实际全发出去了。
  // 反过来不做的：多值 tag 的语义（任一 / 全部）spec 没定，这里不替它定，出口要传数组
  // 就先在出口归一，别在这儿猜。
  const typeList = Array.isArray(filters.type)
    ? filters.type
    : typeof filters.type === "string" && filters.type.trim() ? [filters.type.trim()] : [];
  const wanted = typeList.length ? new Set(typeList) : null;
  const tag = typeof filters.tag === "string" && filters.tag.trim() ? filters.tag.trim() : null;
  const skipped = { archived: 0, forgotten: 0, readonly_type: 0, excluded_type: 0, blank_or_noise: 0, sensitive: 0 };
  const skipList = [];
  const memories = [];
  for (const source of Array.isArray(rows) ? rows : []) {
    if ((wanted && !wanted.has(source?.type)) || (tag && !(Array.isArray(source?.tags) ? source.tags : []).includes(tag))) {
      continue;
    }
    const verdict = classifyRowForShare(source, { redact });
    if (!verdict.include) {
      skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
      if (skipList.length < SHARE_SKIP_LIST_MAX) skipList.push({ title: verdict.title ?? "", reason: verdict.reason });
      continue;
    }
    memories.push({ external_id: deriveExternalId(packId, verdict.row.type, verdict.row.title), ...verdict.row });
  }
  const pack = {
    kind: SHARE_KIND,
    pack_id: packId,
    alias: typeof alias === "string" ? alias.trim() : "",
    generated_at: generatedAt,
    source_version: String(packageVersion ?? ""),
    report: { included: memories.length, skipped, skip_list: skipList },
    memories
  };
  const bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  if (bytes > MAX_PACK_BYTES) {
    return { ok: false, error: "too-large", pack, bytes, limitBytes: MAX_PACK_BYTES };
  }
  return { ok: true, pack, bytes };
}
