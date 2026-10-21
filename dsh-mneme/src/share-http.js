// 分享包在两张皮上共用的解析与答复（形状照 src/reclaim-http.js，#411）。
// 只返回 {status, body}，绝不自己写 res —— 两侧的 sendJson 签名不同（api.js 有
// headers 第四参、api-standalone.js 没有），把写 res 留在各侧 handler 里是唯一
// 能让一份实现喂两张脸的做法。
//
// 哪些行进包、以什么原因不进，一条判据都不在这里重复：那是 src/share.js 的事。本模块
// 只做协议层的事——读 body、把结果包成答复、给一个能落盘的文件名。
import { buildSharePack } from "./share.js";

/** 拒发时的下一步动作。它是给调用方看的，出口只许有一处措辞（同 RECLAIM_CONFIRM_HINT）。 */
const SHARE_ERROR_HINT = "包体超过分享水位：用 --type 或 --tag 分批，别整库外发。";

/**
 * 解析 POST body（已由调用方读成文本）→ buildSharePack 的入参集合。
 *
 * 空 body 等价于 `{}`：分享的主用法就是「一个字节都不发，按整库口径打」。坏 JSON 与
 * 发成数组/null 是两个不同的错码（前者是调用方发坏了，后者是发错了顶层形状），
 * 与 reclaim 侧同款，出口要能分支。
 *
 * 只认这三个键，多余的键丢掉：面板与 CLI 各写各的选项时，静默接受一个拼错的键等于
 * 让她以为筛过了。
 *
 * 这里**没有** dryRun：share 是纯读、不改库，spec §4 明确它不套 reclaim 的
 * dry-run/confirm 纪律，干跑由 CLI 侧的 `--dry-run` 决定（它压根不发这个键）。上一版
 * 把它「登记但不参与答复构造」留着，等于凭空多出一个没人消费的公开字段：今天发
 * `dryRun: true` 的人拿到的是真包，而哪天要给它真语义、或把它删掉，两侧都是破坏性改动。
 * 删掉后它和别的多余键走同一条规则——丢掉，不再是一个特例。
 *
 * @returns {{ok: true, options: {alias?: string, type?: unknown, tag?: unknown}}
 *           | {ok: false, error: string}}
 */
export function parseShareBody(text) {
  if (text === undefined || text === null || String(text).trim() === "") return { ok: true, options: {} };
  let body;
  try {
    body = JSON.parse(String(text));
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid-body" };
  const options = {};
  if (typeof body.alias === "string") options.alias = body.alias;
  // type / tag 在这里只判「填没填」，不判形状。收窄口径是 share.js 的 shareFilterSet，
  // 它钉死的是「读不懂的形状只许收窄到 0 条，不许当没填」（错的方向是少发，当场看得见）。
  // 本层若再校验一次形状、把裸字符串或混进非字符串条目的数组丢成「没填」，就等于在 HTTP
  // 面上把那条洞反着挖开——她以为只发了一类，实际整库进包，而 report 看不出异样。
  if (body.type !== undefined && body.type !== null) options.type = body.type;
  if (body.tag !== undefined && body.tag !== null) options.tag = body.tag;
  return { ok: true, options };
}

/** 包文件名：日期 + pack_id 前 8 位。Content-Disposition 与 CLI 落盘共用这一个拼法。 */
export function shareFilename(packId, now = () => new Date()) {
  const stamp = now().toISOString().slice(0, 10).replace(/-/g, "");
  return `dsh-mneme-share-${stamp}-${String(packId).slice(0, 8)}.json`;
}

/**
 * 组包并给出答复。`service.all()` 是「全库含归档/已遗忘」的现成通道（store.js 的 all()
 * 不带 WHERE），口径判据全在 share.js 里判，本模块不重复任何一条。
 *
 * filters 两个键只在填了时才挂上去：buildSharePack 的默认值兜的是 `filters` 整个参数为
 * undefined，构造一个 `filters: null` 会直接在对端解引用时抛——没填的键就让它不存在。
 *
 * 413 那条绝不回 pack：这条答复存在的原因恰恰是包太大，把 memories 序列化回去等于把
 * 刚拒绝掉的那几 MB 再发一遍。report + 量到的字节 + 水位 + 提示够出口说清「大了多少、
 * 怎么分批」（share.js 超限时也把完整 pack 交回，本层只用它的 report）。
 *
 * 抛错在这里兜住并回 500，不留给调用方的 try：面板侧 handler 的形状是
 * `try { return readBody(...).then(...) } catch`，外层 try 在 .then 的回调里已经退栈，
 * 从这里抛出去就是一个没人接的 rejection，客户端拿到的不是 500 而是「一个字节都没回」
 * （#410，reclaim-http.js 里 reclaimReply 那段注释记的就是这一次）。共用层兜一次，两张
 * 皮才不会因为各自接线不同而有一种会漏。warn 可选：数据面的 logger 未必接得上，少一个
 * 回调也不许把异常漏出去。
 *
 * @param {{service: {all: () => object[]}, packageVersion: string, homeDir: string,
 *          now?: () => Date, options?: object, warn?: ((msg: string) => void)|null}} input
 * @returns {{status: number, body: object}}
 */
export function shareReply({ service, packageVersion, homeDir, now = () => new Date(), options = {}, warn = null }) {
  try {
    const rows = typeof service?.all === "function" ? service.all() : [];
    const filters = {};
    if (options.type !== undefined) filters.type = options.type;
    if (options.tag !== undefined) filters.tag = options.tag;
    const out = buildSharePack({
      rows, alias: options.alias, homeDir, packageVersion,
      filters,
      generatedAt: now().toISOString()
    });
    if (!out.ok) {
      return {
        status: 413,
        body: { error: out.error, bytes: out.bytes, limitBytes: out.limitBytes, hint: SHARE_ERROR_HINT, report: out.pack.report }
      };
    }
    return { status: 200, body: out.pack };
  } catch (error) {
    // 日志里留住原始文本（现场最难下手的就是「只回了 internal」那一类），对外只有一个码。
    warn?.(`[dsh-mneme] share pack failed: ${String(error)}`);
    return { status: 500, body: { error: "internal" } };
  }
}
