/**
 * M.O. 的**开窗命令**：`/mo-run`。
 *
 * ## 为什么需要一条命令，而不是让插件自己判断
 *
 * 「哪条工作流正在被走」这件事**没法自动判**：工作流的 `trigger` 字段是人话
 * （`{kind:"phrase", value:"发版"}`），拿它去匹配用户消息只能猜，而猜错会把一条
 * **从没跑过的流程**记成跑过、还把节点染成可信。所以窗口的边界由**显式动作**划，
 * 这条命令就是那个动作。
 *
 * 与仓库里既有的 `commands.js`（用户自定义指令）不同：那条路只把文本转发给模型，
 * 不持有状态；这一条要真的开/关一个窗口，所以单独成模块。
 *
 * ## 三个子命令
 *
 * - `/mo-run start <pipeline-id>` —— 开窗。之后这个会话里的命令执行才可能被记账
 * - `/mo-run stop` —— 结账并落盘
 * - `/mo-run status` —— 只看「走到哪了」，不结账
 *
 * ## 为什么把结果文本说这么细
 *
 * 命令的回执是这个功能**唯一的对外窗口**（面板那一侧还没做）。它必须能回答：
 * 开的哪条、走了几步、有多少条认不出来、为什么没写账。含糊其辞的回执会让使用者
 * 以为「跑成功了」，而实际可能一条观察都没认出来——那正是这个功能最该避免的事。
 */

import { STR } from "./lang.js";

/** 命令名与用法。名字走本仓的 `COMMAND_NAME` 约定：小写字母起头。 */
export const MO_RUN_COMMAND = "mo-run";

/** 解析 `/mo-run` 后面的原始输入。只认三种子命令，其余交给用法提示。 */
export function parseMoRunInput(rawInput) {
  const text = typeof rawInput === "string" ? rawInput.trim() : "";
  if (text === "") return { action: "status" }; // 不带参数 = 看状态，最安全
  const [verb, ...rest] = text.split(/\s+/u);
  const arg = rest.join(" ").trim();
  switch ((verb ?? "").toLowerCase()) {
    case "start":
      return { action: "start", pipelineId: arg };
    case "stop":
      return { action: "stop" };
    case "status":
      return { action: "status" };
    default:
      return { action: "help", unknown: verb };
  }
}

/**
 * 把「本次观察到哪些业务动作」渲染成几行。
 *
 * 这是这一版回执的**主菜**：自动归属的命中率实测只有 14%，所以回执不再声称
 * "我替你对上了哪几步"，而是如实列出"这一遍你干了什么"，由人决定它对不对得上。
 *
 * 只显示 `动词 子命令 ×次数`（可带旗标）——**位置参数在分桶层就被丢弃了**，
 * 因为完整命令行含绝对路径（路径含本机用户名），而这条回执会显示在界面上。
 * 那也是 pipeline-activities.js 存在的第二个理由。
 */
function renderActivities(activities, t, maxRows = 12) {
  if (!Array.isArray(activities) || activities.length === 0) return "";
  const rows = activities.slice(0, maxRows).map((a) => {
    // 键在没有子命令时用的是第一个旗标（`node --test`）——那种情况下别再把同一个旗标
    // 追加一遍，否则会渲染成 `node --test --test`（端到端复验时抓到的重复）。
    const shown = (a.flags || []).filter((f) => !a.key.endsWith(f));
    const flags = shown.length ? ` ${shown.join(" ")}` : "";
    return `  ${a.key}${flags} ×${a.count}`;
  });
  const more = activities.length > maxRows ? `\n  …另有 ${activities.length - maxRows} 种` : "";
  return `${t.activities(activities.length)}\n${rows.join("\n")}${more}`;
}

/** 把一次 `stop()` 的结果翻成人话。**失败要说清为什么**，不许含糊成「完成」。 */
function describeStop(result, language) {
  const t = STR.moRunStop[language];
  // 观察清单无论成败都要给——它是这个功能当前最可靠的产出。
  const activityBlock = renderActivities(result.activities, t);

  if (result.ok) {
    const parts = [t.ok(result.pipelineId, result.steps)];
    if (activityBlock) parts.push(activityBlock);
    if (result.unobserved?.length) parts.push(t.unobserved(result.unobserved.length, result.unobserved.join("、")));
    if (result.unattributed) parts.push(t.unattributed(result.unattributed));
    if (result.ambiguous) parts.push(t.ambiguous(result.ambiguous));
    if (result.notCommands) parts.push(t.notCommands(result.notCommands));
    if (result.truncated) parts.push(t.truncated);
    return parts.filter(Boolean).join("\n");
  }
  switch (result.reason) {
    case "no-open-window":
      return t.noWindow;
    case "no-observations":
      // 这条最要紧：一条观察都没认出来，绝不写成「完成」。
      return t.nothingObserved(result.bufferedEvents, result.notCommands);
    case "no-steps": {
      // 「没归属到步骤」不等于「什么都没干」——清单才是这一版真正的交付物。
      const parts = [t.noSteps];
      if (activityBlock) parts.push(activityBlock);
      if (result.shellNoise) parts.push(t.shellNoise(result.shellNoise));
      return parts.filter(Boolean).join("\n");
    }
    case "write-failed":
      return t.writeFailed(result.detail);
    default:
      return t.failed(result.reason);
  }
}

function describeStart(result, language) {
  const t = STR.moRunStart[language];
  if (result.ok) return t.ok(result.pipelineId, result.steps);
  switch (result.reason) {
    case "already-open":
      return t.alreadyOpen(result.pipelineId);
    case "pipeline-not-found":
      return t.notFound(result.available?.length ? result.available.join("、") : t.noneAvailable);
    case "pipeline-unreadable":
      return t.unreadable(result.detail);
    case "no-project-root":
      return t.noProject;
    case "no-session":
      return t.noSession;
    default:
      return t.failed(result.reason);
  }
}

function describeStatus(status, language) {
  const t = STR.moRunStatus[language];
  if (!status.open) return t.closed;
  return t.open(status, status.recorded.join("、") || t.none);
}

/**
 * 造命令的 handler。
 *
 * handler 的返回值走 DSH 的 CommandResult 契约：**只作 UI 回执，不会进模型上下文**。
 * 这个功能的目的是记账，不是给模型派活，所以不需要 `agent.followup`。
 */
export function createMoRunHandler({ recorder, language = () => "zh" } = {}) {
  return (invocation) => {
    const lang = language();
    try {
      const parsed = parseMoRunInput(invocation?.rawInput);
      const session = invocation?.agent?.session;

      if (parsed.action === "help") {
        return { kind: "success", text: STR.moRunUsage[lang] };
      }
      if (parsed.action === "start") {
        if (!parsed.pipelineId) return { kind: "error", text: STR.moRunUsage[lang] };
        return { kind: "success", text: describeStart(recorder.start({ session, pipelineId: parsed.pipelineId }), lang) };
      }
      if (parsed.action === "stop") {
        return { kind: "success", text: describeStop(recorder.stop({ session }), lang) };
      }
      return { kind: "success", text: describeStatus(recorder.status({ session }), lang) };
    } catch (error) {
      // 命令是用户主动触发的动作，不是热路径；出错就如实回报，但绝不把异常抛进宿主。
      return { kind: "error", text: STR.moRunUsage[lang] };
    }
  };
}

/**
 * 注册命令。**默认关**：只有旗标打开才注册——beta 功能必须 opt-in，老用户行为不变。
 *
 * 返回 disposer（与仓库其它注册点一致）；没注册时返回 null。
 */
export function registerMoRunCommand({ ctx, recorder, enabled, language = () => "zh" }) {
  if (enabled !== true) return null;
  if (typeof ctx?.commands?.register !== "function") return null;
  return ctx.commands.register({
    name: MO_RUN_COMMAND,
    description: STR.moRunDescription[language()],
    input: { hint: STR.moRunInputHint[language()] },
    handler: createMoRunHandler({ recorder, language })
  });
}
