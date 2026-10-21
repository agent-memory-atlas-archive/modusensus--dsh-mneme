// 记忆分享包的纯核心：取行口径、脱敏、序列化。
// 本模块不认识 store、不认识 http —— 两侧出口（宿主内面板路由与 standalone Bearer
// 数据面）共用的解析与答复在 share-http.js，#411 的教训是这两张皮只许剩鉴权与路径不同。
import { createHash } from "node:crypto";

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
