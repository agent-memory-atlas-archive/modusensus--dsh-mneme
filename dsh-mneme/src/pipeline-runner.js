/**
 * M.O. 的**执行记录器**：把「谁在什么时候按哪条工作流走了一遍」记成一条账。
 *
 * ## 它在整条链里的位置
 *
 *     session/event → pairObservations → attributionCandidates → openRun → appendRun
 *      （宿主事件）    （事件→观察）        （观察→哪一步）        （窗口）   （落盘）
 *
 * 前四段都已各自成模块并被测过。本模块是**把它们串起来的那一层**，也是唯一持有
 * 「当前有哪些窗口开着」这个状态的地方。
 *
 * ## 四个刻意的取舍
 *
 * 1. **窗口按会话开，一个会话同时只允许一个**。一次执行是「这条流程走一遍」，不是
 *    「同时走两条」。再开一个会被**拒**（`already-open`）而不是顶掉前一个——顶掉会让
 *    前一次的执行悄无声息地消失，那比拒绝难查得多。
 *
 * 2. **事件先缓冲、到 stop 才配对**。`tool/call` 与 `tool/result` 靠 callId 配对，结果
 *    可能比调用晚很久；边到边配会把「还没等到结果」误判成「没有这个调用」。
 *
 * 3. **v1 只在显式 stop 时结账**，不在回合结束时自动关。一条流程常常跨多个回合
 *    （跑测试 → 等人点头 → 再继续），按回合关会把一次执行切成好几条半截账。
 *    代价是忘了 stop 会一直开着——所以缓冲有上限，超了标 `truncated` 并如实写出。
 *
 * 4. **热路径上永不抛**。挂的是宿主每个会话事件的通道，本仓对此有明文不变量
 *    （`continuity.js` 的「可选插件的可选能力把 agent 的一步带崩，比丢一次抢救严重
 *    得多」）。所有异常只 `warn`，绝不让宿主的一步失败。
 *
 * ## 一个尚未实测的前提
 *
 * `session/event` 的实时通道是否**逐条**投递 `tool/call` 与 `tool/result`，我没有在
 * 活宿主上验过（本仓现有消费者只用 `turn/end` 与压缩边缘；工具事件是从**日志文件**
 * 读的）。事件类型联合与落盘日志都包含它们，所以同一通道应当也带——但这是**推断**，
 * 接线后要用一次真实执行验证（开窗走一遍，看账里有没有步骤）。本模块把这件事做成
 * 可观测的：`stop()` 的返回里给出缓冲到多少条事件，一条都没缓冲到时会有
 * `reason:"no-observations"`，而不是写一条空账假装成功。
 */

import { loadPipelines, pipelineSources, projectPipelineDir } from "./pipeline.js";
import { appendRun } from "./pipeline-runs.js";
import { openRun } from "./pipeline-exec.js";
import { pairObservations } from "./pipeline-observe.js";
import { tallyActivities } from "./pipeline-activities.js";

/** 一个窗口最多缓冲多少条会话事件。忘了 stop 时，这是内存的兜底。 */
export const MAX_BUFFERED_EVENTS = 4000;

/**
 * 会话的工作目录。与 `scope.js` 同一口径：`session.header` 是创建时冻结的那份
 * （含 `cwd`），**不能先读 `requestHeader()`** —— 那返回请求级模型路由头，会把
 * `cwd` 遮蔽掉（scope.js 里记着本地 web 实测踩中过）。
 */
export function projectRootOf(session) {
  const header = session?.header ?? session?.requestHeader?.()?.config ?? null;
  const cwd = header?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
}

/**
 * 默认的工作流解析：项目层优先、全局层兜底（与 `readPipelineDoc` 同一优先级）。
 *
 * 坏文件按 `loadPipelines` 的纪律**照抛**，由调用方兜住并如实回报——静默跳过会让
 * 「这条流程读不出来」与「没有这条流程」长得一样。
 */
export function defaultResolvePipeline(projectRoot, pipelineId) {
  for (const source of pipelineSources({ projectRoot })) {
    const list = loadPipelines(source.dir, { scope: source.scope, label: source.label });
    const hit = list.find((p) => p.id === pipelineId);
    if (hit) return hit;
  }
  return null;
}

/** 所有工作流的 id 清单（给命令的用法提示与「你指的是哪条」用）。 */
export function listPipelineIds(projectRoot) {
  const ids = [];
  try {
    for (const source of pipelineSources({ projectRoot })) {
      for (const p of loadPipelines(source.dir, { scope: source.scope, label: source.label })) {
        if (!ids.includes(p.id)) ids.push(p.id);
      }
    }
  } catch {
    // 清单只是提示信息，读不出来不该让命令本身失败。
  }
  return ids;
}

/**
 * 造一个记录器。
 *
 * 除了 `ctx` 之外的所有依赖都可注入（`resolvePipeline` / `persistRun` / `now`），
 * 这样测试不必碰真文件系统，也能精确控制时间。
 */
export function createExecutionRecorder({
  ctx,
  logger = null,
  resolvePipeline = defaultResolvePipeline,
  persistRun = appendRun,
  now = () => new Date(),
  maxBufferedEvents = MAX_BUFFERED_EVENTS
} = {}) {
  const windows = new Map(); // sessionId → { pipeline, projectRoot, run, events, truncated }

  const unsubscribe = ctx?.on?.("session/event", (session, event) => {
    try {
      const id = session?.id;
      if (!id) return;
      const w = windows.get(id);
      // 没有开窗 = 一个字都不记。这是整个设计的地基：漏记可接受，编造不可。
      if (!w) return;
      const type = event?.type;
      if (type !== "tool/call" && type !== "tool/result") return;
      if (w.events.length >= maxBufferedEvents) {
        w.truncated = true;
        return;
      }
      w.events.push(event);
    } catch (error) {
      logger?.warn?.(`dsh-mneme: 执行记录器读事件失败：${String(error)}`);
    }
  });

  return {
    /**
     * 开窗。`pipelineId` 由调用方点名——**本模块不猜**「用户刚才那句话是不是意味着
     * 开始走某条流程」。猜错会把一条从没跑过的流程记成跑过。
     */
    start({ session, pipelineId } = {}) {
      const id = session?.id;
      if (!id) return { ok: false, reason: "no-session" };
      const open = windows.get(id);
      if (open) return { ok: false, reason: "already-open", pipelineId: open.pipeline.id };

      const projectRoot = projectRootOf(session);
      if (!projectRoot) return { ok: false, reason: "no-project-root" };

      let pipeline;
      try {
        pipeline = resolvePipeline(projectRoot, pipelineId);
      } catch (error) {
        return { ok: false, reason: "pipeline-unreadable", detail: String(error?.message ?? error) };
      }
      if (!pipeline) {
        return { ok: false, reason: "pipeline-not-found", available: listPipelineIds(projectRoot) };
      }

      const run = openRun({ pipeline, by: "main", triggeredBy: String(pipelineId ?? ""), now });
      windows.set(id, { pipeline, projectRoot, run, events: [], truncated: false });
      return { ok: true, pipelineId: pipeline.id, steps: pipeline.steps.length };
    },

    /** 结账。先摘窗口再写盘：即便写失败，也不该留一个半死的窗口挂在那儿。 */
    stop({ session } = {}) {
      const id = session?.id;
      if (!id) return { ok: false, reason: "no-session" };
      const w = windows.get(id);
      if (!w) return { ok: false, reason: "no-open-window" };
      windows.delete(id);

      const { observations, dangling, notCommands } = pairObservations(w.events);
      for (const observation of observations) w.run.observe(observation);
      const closed = w.run.close();

      // 本次窗口**观察到哪些业务动作**——与「能不能归属到步骤」无关。
      // 这是这一版的重点：自动归属命中率实测只有 14%，所以回执的主要价值
      // 不再是"我替你对上了哪几步"，而是"我如实告诉你这一遍都干了什么"。
      const activityTally = tallyActivities(observations);

      const common = {
        pipelineId: w.pipeline.id,
        bufferedEvents: w.events.length,
        truncated: w.truncated,
        observations: observations.length,
        notCommands,
        dangling: dangling.length,
        unattributed: closed.unattributed.length,
        ambiguous: closed.ambiguous.length,
        unobserved: closed.unobserved,
        activities: activityTally.activities,
        shellNoise: activityTally.shellNoise
      };

      // 一条观察都没认出来：如实说，不写空账。这同时是「实时通道到底带不带工具事件」
      // 的探针——接线后第一次开窗走一遍，看这里是不是 0。
      if (closed.run === null) {
        return { ok: false, reason: observations.length === 0 ? "no-observations" : closed.reason, ...common };
      }

      try {
        persistRun(w.projectRoot, w.pipeline.id, closed.run);
      } catch (error) {
        return { ok: false, reason: "write-failed", detail: String(error?.message ?? error), ...common };
      }
      return { ok: true, steps: closed.run.steps.length, ...common };
    },

    /** 只看状态，不结账。窗口开着时也能回答「走到哪了」。 */
    status({ session } = {}) {
      const id = session?.id;
      const w = windows.get(id);
      if (!w) return { open: false };
      return { ...w.run.state(), bufferedEvents: w.events.length, truncated: w.truncated };
    },

    dispose() {
      try {
        unsubscribe?.();
      } catch {
        /* 重复 dispose 不报错 */
      }
      windows.clear();
    }
  };
}
