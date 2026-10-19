// v0.8.0 A1（issue #17）：写入端 scope 解析。
//
// 身份模型（issue #17 的核心约定）：session 只是「载体」，记忆挂在持久化身份
// 标签上——agent_scope = session header 的 agentPreset（跨会话稳定的 agent 模板
// 身份），workspace_scope = 会话工作目录（registry 反查的 canonical path 优先，
// header.cwd 兜底）。session_id 永不作为作用域键。
//
// 硬约束：解析失败绝不阻塞写入——任何一步取不到就落 NULL（读侧 NULL = 未标注
// = 全局可见），任何异常都被吞掉（registry 故障 warn 一次后降级）。
//
// v0.8.1（issue #170 复核项 2）：scopeEnabled 的闸门从解析器挪到「写标注」处
// （memory_save 的 auto 分支）。解析器恒返回会话身份（真取不到才是 null）——
// 读取侧（strictVisibility / memory_get / inject）与显式声明都依赖它：flag 关
// 只关「自动标注」，不能连读取身份一起关，否则 strictScope 硬墙被静默拆掉
// （fail-open）。

/**
 * 免 inject 读取一个可选服务。cordis 4 的 ctx 是 Proxy，裸读未在 inject 声明的
 * 属性会抛 "cannot get property ... without inject"（不是返回 undefined），所以
 * 有 reflect 时优先走 ctx.reflect.get；旧宿主没有 reflect、ctx 是普通对象，裸读
 * 此时安全——与 api.js:205 / index.js:583 的 webServer 同一形状。
 *
 * 服务缺失是合法状态（headless / 旧宿主 / 服务未激活），返回 undefined 让调用方
 * 走既有降级路径，不告警：这不是故障。
 * @param {object} ctx
 * @param {string} name
 * @returns {*}
 */
function readOptionalService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(name);
    return ctx?.[name];
  } catch {
    // 无 reflect 却又是 Proxy（或 accessor 自身抛错）：按「未提供」处理。
    return undefined;
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.ctx] 宿主上下文（可能带 workspaceRegistry；旧版 dsh 没有）
 * @param {object} [deps.config] 已解析配置（读 scopeEnabled）
 * @param {object} [deps.logger]
 * @returns {(exec: object) => {agent_scope: string|null, workspace_scope: string|null}|null}
 */
export function createScopeResolver({ ctx, config, logger } = {}) {
  let warned = false;
  const warnOnce = (msg) => {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(msg);
    } catch {
      // logger 自身故障同样不能影响写入路径
    }
  };

  return function resolveWriteScope(exec) {
    const session = sessionOf(exec);

    // 持久化 header（issue #17 的身份契约）：session.header 是创建时冻结的
    // SessionHeader（含 agentPreset/cwd）。⚠️ 不能先读 requestHeader()——那返回
    // EpochHeader（请求级模型路由头，首个请求后即为真值），会把 session.header
    // 遮蔽掉，agentPreset/cwd 双双取空（本地 web 复验 2026-09-13 实测踩中）。
    // 仅当宿主没有 .header 属性时才降级尝试 requestHeader().config（旧形状）。
    let header = null;
    try {
      header = session?.header ?? session?.requestHeader?.()?.config ?? null;
    } catch {
      header = null;
    }

    // header 字段的读取要各自护住：session.header 本身取得回来，不代表它的字段
    // 取得回来——宿主可以给出会抛错的 accessor（sessionOf / sessionKeyOf 就是为
    // 同一类宿主写的）。漏在这里的异常会穿出解析器，把调用方的整段写入拖挂：
    // 蒸馏路径上是一个窗口的记忆与游标一起丢，工具路径上是一次 memory_save 直接失败。
    let agentScope = null;
    try {
      const preset = header?.agentPreset;
      if (typeof preset === "string" && preset.trim()) agentScope = preset.trim();
    } catch (e) {
      warnOnce(`[dsh-mneme] session header agentPreset lookup failed: ${String(e)}`);
    }

    // workspace：registry 反查优先（成员资格 = id 命中 + header canonical cwd
    // 校验过，path 已 realpath 归一），失败回退 header.cwd，再失败留 NULL。
    //
    // issue #487：这里曾经是裸读 ctx?.workspaceRegistry，而 workspaceRegistry 不在
    // inject 声明里（index.js:45）。cordis 4 的 ctx 是 Proxy，裸读未注入属性会抛
    // "cannot get property ... without inject" 而不返回 undefined——于是这层反查
    // 从 v0.8.0 起一直抛错走降级，canonical 归一与成员资格校验静默失效，只剩
    // header.cwd。改用免 inject 读取（同 api.js:205 / index.js:583 的 webServer
    // 先例）；不加进 inject 的理由见 index.js:39-44（v0.7.23 的 apply 阶段崩溃）。
    let workspaceScope = null;
    try {
      const list = readOptionalService(ctx, "workspaceRegistry")?.list?.();
      const sessionId = session?.id;
      if (Array.isArray(list) && sessionId != null) {
        const hit = list.find(
          (ws) => Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId)
        );
        if (typeof hit?.path === "string" && hit.path.trim()) workspaceScope = hit.path.trim();
      }
    } catch (e) {
      warnOnce(
        `[dsh-mneme] workspaceRegistry lookup failed, falling back to session header cwd: ${String(e)}`
      );
    }
    if (!workspaceScope) {
      try {
        const cwd = header?.cwd;
        if (typeof cwd === "string" && cwd.trim()) workspaceScope = cwd.trim();
      } catch (e) {
        warnOnce(`[dsh-mneme] session header cwd lookup failed: ${String(e)}`);
      }
    }

    return { agent_scope: agentScope, workspace_scope: workspaceScope };
  };
}

/**
 * 工具 exec 上的会话对象。宿主 ctx 是 Proxy（cordis 4），裸读未 inject 的属性会
 * 抛错——所以取值恒包在 try 里，取不到返回 null。scope 解析与写入准入的会话键
 * 共用这一处取值口径。
 * @param {object} exec
 * @returns {object|null}
 */
export function sessionOf(exec) {
  try {
    return exec?.agent?.session ?? null;
  } catch {
    return null;
  }
}

/**
 * 写入准入的会话键（#254 G1 会话写入预算的计数单位）。session_id 在这里只作
 * 「同一段对话」的标识，不作为作用域键（见文件头：记忆挂在持久化身份标签上）；
 * 取不到会话身份（系统写入）返回 null = 不进预算。
 * @param {object} exec
 * @returns {string|null}
 */
export function sessionKeyOf(exec) {
  // 整个取值（含 .id）都在 try 里：宿主 session 可能是会抛错的 accessor，而这个
  // 函数在 memory_save 的保存之前被调用——抛出去就是一次工具调用直接失败。
  try {
    const id = sessionOf(exec)?.id;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

/**
 * v0.8.1 底座（issue #170）：显式 scope 参数（memory_save / memory_update /
 * 面板编辑）的归一化。约定：
 *   - 省略（undefined，由调用方判断）= 该维不声明，回落载体自动标注；
 *   - "global"（大小写不敏感）/ "*" / 空白 = 显式声明全局 → 存储 NULL
 *     （行上的 agent_scope_source='explicit' 承担「显式全局」与「从未标注」
 *     的区分，NULL 本身继续表示全局可见）；
 *   - 其余非空 trim 字符串 = 收窄到该标签。
 * 脏输入（非字符串）落 NULL（等同声明全局）——与 resolveWriteScope 的「解析
 * 绝不阻塞写入」同一哲学：显式声明是用户意图，形状不对时宁可放宽不报错。
 *
 * @param {unknown} raw 工具/HTTP 参数原值
 * @returns {string|null} 归一化后的标签值（null=显式全局）
 */
export function normalizeExplicitScope(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s === "*" || s.toLowerCase() === "global") return null;
  return s;
}

/**
 * scope 标注的比较键（去重键/检索加权/跨 scope 配对共用口径）：非空 trim 字符串
 * 原样返回，其余（NULL/undefined/空串/非字符串）统一为 null（「未标注」）。
 * v0.8.1（issue #170 第 2 步）从 service.js 上提为共享定义——sleep 的跨 scope
 * 候选配对必须与去重键用同一把钥匙，NULL 与已标注才不会错配。
 *
 * @param {unknown} v scope 标注原值
 * @returns {string|null} 比较键（null=未标注）
 */
export function scopeKeyOf(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
