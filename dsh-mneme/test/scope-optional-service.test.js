import test from "node:test";
import assert from "node:assert/strict";
import { createScopeResolver } from "../src/scope.js";

// issue #487：workspaceRegistry 不在 inject 声明里（src/index.js:45），而 cordis 4
// 的 ctx 是 Proxy——裸读未注入属性会抛 "cannot get property ... without inject"，
// 不返回 undefined。于是 scope.js 曾经那行 `ctx?.workspaceRegistry?.list?.()` 从
// v0.8.0 起必然抛错走降级：canonical path 归一与成员资格校验静默失效，只剩
// header.cwd。
//
// 为什么既有测试没拦住：scope-storage.test.js 里三处 registry 测试都用普通对象
// 伪造 ctx（{ workspaceRegistry: {...} }），普通对象裸读不抛错。本文件改用
// 「读未声明属性即抛」的 Proxy 复刻真实宿主形状，把两侧行为都钉死。

/**
 * cordis 4 形状的 ctx：只有显式提供的属性可读，其余一律抛错（不是 undefined）。
 * @param {object} provided 已提供的属性（reflect / logger …）
 */
function proxyCtx(provided) {
  return new Proxy(provided, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then" || String(prop).startsWith("_")) {
        return target[prop];
      }
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    }
  });
}

/** 带 workspaceRegistry 服务的 reflect（免 inject 读取出口）。 */
function reflectWith(services, seen = []) {
  return {
    get(name) {
      seen.push(name);
      return services[name];
    }
  };
}

const EXEC = { agent: { session: { id: "s1", header: { agentPreset: "coder", cwd: "D:\\raw" } } } };

function loggerSpy() {
  const warnings = [];
  return { warnings, logger: { warn: (m) => warnings.push(String(m)) } };
}

test("#487: unregistered ctx property never throws out of the resolver (Proxy shape)", () => {
  // 没有任何服务：裸读 workspaceRegistry 在真宿主里会抛。解析器必须吞掉并降级。
  const { warnings, logger } = loggerSpy();
  const ctx = proxyCtx({ reflect: reflectWith({}), logger });
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true }, logger });
  // 不会抛；agentPreset 照常解析，workspace 落到 header.cwd。
  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "D:\\raw" });
  // 服务缺失是合法状态（headless / 旧宿主），不是故障——不许刷 warn。
  assert.deepEqual(warnings, [], "missing optional service must stay silent");
});

test("#487: registry reached through reflect.get restores the canonical path", () => {
  // 修复的收益不只是消 warning：宿主确实提供 workspaceRegistry（@deepseek-ai/
  // dsh-workspace），走免 inject 读取能取回 realpath 归一后的 canonical path，
  // 而不是退化成原始 cwd 字符串。
  const registry = { list: () => [{ path: "C:\\canon", sessionIds: ["s1"] }] };
  const seen = [];
  const ctx = proxyCtx({ reflect: reflectWith({ workspaceRegistry: registry }, seen) });
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true } });

  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "C:\\canon" });
  assert.ok(seen.includes("workspaceRegistry"), "registry must be read via reflect.get");
});

test("#487: membership miss still falls back to header cwd (registry hit is id-scoped)", () => {
  const registry = { list: () => [{ path: "C:\\canon", sessionIds: ["other"] }] };
  const ctx = proxyCtx({ reflect: reflectWith({ workspaceRegistry: registry }) });
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true } });

  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "D:\\raw" });
});

test("#487: hosts without ctx.reflect keep working through the plain-object shape", () => {
  // 旧宿主：ctx 是普通对象、没有 reflect.get。普通对象裸读安全，行为必须和修复前一致。
  const ctx = { workspaceRegistry: { list: () => [{ path: "C:\\canon", sessionIds: ["s1"] }] } };
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true } });
  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "C:\\canon" });
});

test("#487: registry explosion still degrades to header cwd and warns exactly once", () => {
  // 既有语义（scope-storage.test.js 已有同款普通对象版）：服务确实炸了要出声，
  // 但每次写一个解析器实例只警告一次、绝不影响写入。
  const { warnings, logger } = loggerSpy();
  const registry = { list: () => { throw new Error("boom"); } };
  const ctx = proxyCtx({ reflect: reflectWith({ workspaceRegistry: registry }), logger });
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true }, logger });

  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "D:\\raw" });
  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "D:\\raw" });
  assert.equal(warnings.length, 1, "warn once per resolver instance, never on every write");
});

test("#487: resolver never throws even when reflect.get itself explodes", () => {
  const { logger } = loggerSpy();
  const ctx = proxyCtx({
    reflect: { get() { throw new Error("reflect boom"); } },
    logger
  });
  const resolve = createScopeResolver({ ctx, config: { scopeEnabled: true }, logger });
  assert.deepEqual(resolve(EXEC), { agent_scope: "coder", workspace_scope: "D:\\raw" });
  // 无会话时照旧全 NULL（fail-closed 读取侧依赖这个契约）。
  assert.deepEqual(resolve(undefined), { agent_scope: null, workspace_scope: null });
});
