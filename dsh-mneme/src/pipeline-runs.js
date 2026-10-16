/**
 * M.O.（Modus Operandi · 手法）工作流的**运行账**。
 *
 * 读侧（`src/pipeline.js`）已经能把「一条工作流跑了怎么样」算成四态，但账本一直没人写，
 * 于是 `runs` 恒为空数组、节点状态恒为 `candidate`。本模块补的就是这一环：把一次 run
 * 落到盘上、再读回来成读侧认得的那份形状。
 *
 * **落点为什么跟手写的 `.json` 分开**：`<项目>/.mneme/pipelines/<id>.json` 是人手写、
 * 要 review、要提交的；账本是每跑一次就追加一行的流水。挤进同一个文件，一次 run 就会
 * 把人的 diff 冲掉，而人改过的内容与机器追加的内容此后再也分不开。
 *
 * **为什么是 JSONL 不是一个大 JSON 数组**：追加一条要重写整个数组，而这个文件会被
 * 「刚刚跑完一次」这种**不能失败**的动作写。一行一条时，写到一半断电只毁最后一行；
 * 整份重写时，同样的故障会毁掉全部历史。
 *
 * 形状以读侧的 `tallyRuns` 为准（那里是权威）：只有 `skipped` 与 `detoured` 都为假才算
 * 一次 `uses`，两者各自独立累加，`refuted` 只当布尔用，`step.at` 取最大值当 `lastUsedAt`。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ACTORS } from "./pipeline.js";

/** 账本的后缀：与手写工作流的 `.json` 分开，正是为了避免同 id 撞名。 */
export const RUNS_SUFFIX = ".runs.jsonl";

/** 校验失败的统一出口。名字与 `PipelineError` 成对：一个是工作流写坏了，一个是账本写坏了。 */
export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunError";
  }
}

const bad = (msg) => {
  throw new RunError(msg);
};

/**
 * id 只当**一个文件名片段**用，绝不当路径用。
 *
 * 拒掉而不是清洗：清洗会把 `../../x` 悄悄变成 `x`，于是写到了调用方没指定的文件上
 * ——那类错在界面上看不出来，是最难查的一种。`..` 单独一个也要拒：它合法地通过
 * 「无分隔符」检查，却仍然指向上级目录。
 */
function isSafeSegment(id) {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (value === "" || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (isAbsolute(value)) return false;
  return true;
}

/**
 * 账本的家：`<项目>/.mneme/pipelines/`。目录名与读侧同一处来源（同一段路径拼接），
 * 免得两边各写一份常量、改一处漏一处。
 */
export function runsDir(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    bad("projectRoot 必须是项目根的路径");
  }
  return join(projectRoot, ".mneme", "pipelines");
}

/** 一个 id 的账本文件：`<项目>/.mneme/pipelines/<id>.runs.jsonl`。 */
export function runsPath(projectRoot, id) {
  const dir = runsDir(projectRoot);
  if (!isSafeSegment(id)) bad(`id 不是合法的文件名片段：${JSON.stringify(id)}`);
  const full = resolve(dir, id.trim() + RUNS_SUFFIX);
  // 双保险：片段检查已经挡掉了穿越，这里再确认落点确实在账本目录里
  // ——将来有人放宽上面的检查时，这一层会先变红。
  if (!full.startsWith(resolve(dir))) bad(`id 会写到账本目录之外：${JSON.stringify(id)}`);
  return full;
}

/**
 * 时间戳收成规范的 ISO 毫秒 UTC 串。
 *
 * 收成**唯一一种**形状是刻意的：`step.at` 会被读侧按字符串比较取最大值当 `lastUsedAt`，
 * 同一条账里混着 `2026-10-15T09:00:01Z` 与 `2026-10-15T09:00:01.500Z` 时，比较结果
 * 与人对时间先后的直觉不一致。写进来的那一刻就把它们拉齐。
 */
function normalizeAt(value, where) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) bad(`${where} 是一个无效的 Date`);
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") bad(`${where} 不能是空字符串`);
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) bad(`${where} 不是能解析的时间：${JSON.stringify(value)}`);
    return new Date(ms).toISOString();
  }
  bad(`${where} 必须是 ISO 时间串、Date 或毫秒数，收到 ${value === null ? "null" : typeof value}`);
}

function requireRecord(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${where} 必须是一个对象`);
  return value;
}

function readBool(value, where) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") bad(`${where} 必须是布尔`);
  return value;
}

/**
 * 把一条 run 收成契约形状：缺的补默认、多余的丢掉、坏的直接抛。
 *
 * 「坏的直接抛」与读侧 `loadPipelines` 同一纪律：**静默跳过最难查**——账本里少一条，
 * 面板上看起来只是「这条工作流好像没跑过」，而真相是有一次运行丢了。
 */
export function normalizeRun(raw, { expectedStepIds = null } = {}) {
  const run = requireRecord(raw, "run");
  const at = normalizeAt(raw.at, "run.at");

  const by = typeof raw.by === "string" ? raw.by.trim() : raw.by;
  if (!ACTORS.includes(by)) bad(`run.by 必须是 ${ACTORS.join(" / ")} 之一，收到 ${JSON.stringify(raw.by)}`);

  const triggeredBy = raw.triggeredBy === undefined || raw.triggeredBy === null ? "" : raw.triggeredBy;
  if (typeof triggeredBy !== "string") bad(`run.triggeredBy 必须是字符串（trigger.value 或空串），收到 ${typeof raw.triggeredBy}`);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    bad("run.steps 至少要有一条——一次什么步骤都没走过的 run 不提供任何账");
  }
  const expected = expectedStepIds ? new Set(expectedStepIds) : null;
  const steps = raw.steps.map((rawStep, i) => {
    const step = requireRecord(rawStep, `run.steps[${i}]`);
    const id = typeof step.id === "string" ? step.id.trim() : step.id;
    if (!isSafeSegment(id)) bad(`run.steps[${i}].id 不是合法的步骤 id：${JSON.stringify(step.id)}`);
    // 图里没有的步骤 id 会让账落在一个没有节点的地方：tallyRuns 数得出来，面板上
    // 却永远看不见它。当场报出来，而不是写一条「写了但看不见」的记录。
    if (expected && !expected.has(id)) {
      bad(`run.steps[${i}].id "${id}" 不在工作流的步骤表里（${[...expected].join(" / ")}）`);
    }
    const note = step.note === undefined || step.note === null ? "" : step.note;
    if (typeof note !== "string") bad(`run.steps[${i}].note 必须是字符串`);
    return {
      id,
      at: normalizeAt(step.at, `run.steps[${i}].at`),
      skipped: readBool(step.skipped, `run.steps[${i}].skipped`),
      detoured: readBool(step.detoured, `run.steps[${i}].detoured`),
      refuted: readBool(step.refuted, `run.steps[${i}].refuted`),
      note
    };
  });

  return { at, by, triggeredBy, steps };
}

/**
 * 读一个项目的账本；**空是实话，坏要说话**。
 *
 * 目录不存在、文件不存在、文件是空的 → 空数组：一条工作流还没跑过是正常状态，
 * 面板据此画空态而不是画成「读不出来」。
 * 有一行读不出来 → 抛：静默跳过会让「账本坏了」与「还没跑过」长得一模一样。
 */
export function readRuns(projectRoot, id) {
  const file = runsPath(projectRoot, id);
  if (!existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RunError(`${id}${RUNS_SUFFIX}: 读不出来：${error.message}`);
  }
  if (text.trim() === "") return [];

  // 只吃**行尾**那一个换行；文件中间的空行是坏行，不是「可以忽略的一行」。
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, index) => {
    const where = `${id}${RUNS_SUFFIX} 第 ${index + 1} 行`;
    if (line.trim() === "") throw new RunError(`${where}: 空行`);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new RunError(`${where}: JSON 解析失败（${error.message}）；这一行是 ${line.slice(0, 120)}`);
    }
    try {
      return normalizeRun(parsed);
    } catch (error) {
      throw new RunError(`${where}: ${error.message}`);
    }
  });
}

/**
 * 追加一条 run（一次 run 一行）。
 *
 * 写之前只做一件事：确认已有内容以换行结尾。少了它，追加会把上一条与本条**粘成一行**，
 * 于是一行坏 JSON 让整个账本读不出来——而账本是「刚刚跑完一次」时才动的文件，
 * 恰恰是最不该在这种地方失败的那一个。
 */
export function appendRun(projectRoot, id, run) {
  const file = runsPath(projectRoot, id);
  const normalized = normalizeRun(run);
  mkdirSync(runsDir(projectRoot), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    appendFileSync(file, prefix + JSON.stringify(normalized) + "\n", "utf8");
  } catch (error) {
    throw new RunError(`${id}${RUNS_SUFFIX}: 写不进去：${error.message}`);
  }
  return normalized;
}

/**
 * 一次问一批 id 的账本，供 `/pipeline` 端点喂给 `readPipelineDoc`。
 *
 * 一条账本坏了不该让整个面板打不开（与「项目层坏一个 .json 不拖死全局层」同一口径），
 * 但**也不能假装它没坏**：坏的那条不进 `runsById`，改从 `errors` 里如实回来，
 * 端点据此在响应里带上噪音。缺账本与坏账本因此长得不一样。
 */
export function loadRunsById(projectRoot, ids) {
  const runsById = Object.create(null);
  const errors = [];
  for (const id of ids || []) {
    try {
      runsById[id] = readRuns(projectRoot, id);
    } catch (error) {
      runsById[id] = [];
      errors.push({ id, detail: String((error && error.message) || error) });
    }
  }
  return { runsById, errors };
}
