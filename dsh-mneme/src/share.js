// 记忆分享包的纯核心：取行口径、脱敏、序列化。
// 本模块不认识 store、不认识 http，也不读 config —— 两侧出口（宿主内面板路由与
// standalone Bearer 数据面）共用的解析与答复在 share-http.js，#411 的教训是这两张皮
// 只许剩鉴权与路径不同。
// 唯一进来的外部判据是两个纯函数（write-admission 的空白/噪声、sensitive-scan 的
// 密钥/PII）：判据只许有一份，所以这里 import 而不是重抄，代价是模块图会连带把
// store 模块**加载**进来（write-admission → service → store）—— 加载不等于使用，
// 本模块不调它任何一个方法，也不碰 config。
import { createHash } from "node:crypto";
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

/** 幂等键：NUL 分隔，防 ("ab","c") 与 ("a","bc") 撞同一键。 */
export function deriveExternalId(packId, type, title) {
  return createHash("sha256")
    .update(`${packId}\u0000${type}\u0000${String(title ?? "").trim()}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把正文里的本机 home 前缀换成 `~`。两个形态都要替：Windows 上同一目录既能写成
 * 反斜杠也能写成正斜杠（Node 两边都收），只替一种等于漏一半——漏掉的那一半就是
 * 用户名。大小写不敏感：盘符与用户目录在真实路径里的大小写常常和 homedir() 不一致。
 */
export function createHomeRedactor(homeDir) {
  const base = typeof homeDir === "string" ? homeDir.trim() : "";
  if (base.length < 2) return (text) => String(text ?? "");
  // 正反两个方向都展开（不是只从 base 派生反斜杠那一半）：homedir() 给的是
  // `C:\Users\alex`，而正文里同一目录常被写成 `C:/Users/alex`，只补一个方向就漏那个方向。
  const forms = [...new Set([base, base.replace(/[\\/]/g, "\\"), base.replace(/[\\/]/g, "/")])];
  const re = new RegExp(`(?:${forms.map(reEsc).join("|")})[\\\\/]?`, "gi");
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
 */
export function classifyRowForShare(row, { redact = (t) => t } = {}) {
  if (row?.archived) return { include: false, reason: "archived", title: row?.title };
  if (row?.forgotten) return { include: false, reason: "forgotten", title: row?.title };
  if (SHARE_READONLY_TYPES.has(row?.type)) return { include: false, reason: "readonly_type", title: row?.title };
  if (SHARE_EXCLUDED_TYPES.has(row?.type)) return { include: false, reason: "excluded_type", title: row?.title };
  if (informationlessReason(row)) return { include: false, reason: "blank_or_noise", title: row?.title };
  // 扫描面用 `scanSensitive` 这个「任意文本」口径的导出，不用带开关的那个工厂面：
  // 工厂在 sensitiveScanEnabled 关时返回 null（sensitive-scan.js:199），而那个键管的是
  // **写入侧**可观测性。分享边界本身就是安全边界（spec §4）——用户没开写入闸门时
  // 恰恰最需要这里照常在扫，跟着开关走等于裸发整库。
  const scanned = scanSensitive([row?.title, row?.content, ...(Array.isArray(row?.tags) ? row.tags : [])]
    .filter((s) => typeof s === "string").join("\n"));
  if (scanned) return { include: false, reason: "sensitive", title: row?.title };
  const content = redact(row?.content ?? "");
  const title = redact(row?.title ?? "");
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
      // 对面入库时 store 会按自己的口径重算 content_hash（store.js:1160），这份只是
      // 包内的自证：让接收侧能核对「正文没在路上被改」。
      content_hash: row.content_hash ?? null
    }
  };
}
