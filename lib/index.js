// Cordis 插件入口（宿主半边）。
//
// 职责：装配内核、注册 5 个工具、注入状态提示段、挂载 Web API。
// apply() 里不做任何扫描：索引只在用户手动触发同步时才变化。

import { createKbCore } from './core.js';
import { registerTools } from './tools.js';
import { registerWebApi } from './web.js';
import { buildStateText } from './prompt.js';

export const name = 'dsh-company-kb';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const core = createKbCore(config, { logger });

  ctx.effect(() => () => {
    try { core.dispose(); } catch { /* 已经释放 */ }
  }, 'dsh-company-kb: dispose');

  ctx.effect(() => registerTools(ctx, core), 'dsh-company-kb: tools');

  // 状态提示段：让模型知道本会话能不能用知识库、索引是否为空或已过期
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const transformed = await next();
    if (context?.agent === undefined) return transformed;
    try {
      const text = buildStateText(core, context.agent);
      if (text.length === 0) return transformed;
      const contexts = Array.isArray(transformed.contexts) ? transformed.contexts : [];
      return {
        ...transformed,
        contexts: [...contexts.filter(item => item?.name !== 'dsh-company-kb:state'), { name: 'dsh-company-kb:state', text }],
      };
    } catch (error) {
      logger.warn?.(`dsh-company-kb: 状态提示段生成失败：${error.message}`);
      return transformed;
    }
  });

  // Web 面板 API（与 DSH 同源，仅回环可访问）
  //
  // 两个坑都踩过，写在这里免得重蹈：
  //  1) 只能用 ctx.get('webServer')。写成 `ctx.webServer ?? ctx.get(...)` 会踩 Cordis 的
  //     Guard —— 未在 inject 里声明就访问 ctx.webServer 会直接抛错
  //     （service "webServer" is not declared），而这个错恰好会被 try/catch 吞掉。
  //  2) 不能假设 apply() 执行时 webServer 已经就绪：本行只依赖 tools，激活可能早于
  //     webserver 行。实测 `ctx.get('webServer')` 在这一刻就是 undefined，于是"工具正常、
  //     面板全部 404"。所以先立即试一次，拿不到就轮询等服务出现（最多 30 秒）。
  const settings = core.settings();
  if (settings.exposeWeb === false) {
    core.runtime.webApi = { state: 'disabled', path: settings.webPath };
  } else {
    const tryRegister = () => {
      try {
        const webServer = ctx.get('webServer');
        if (webServer === undefined || typeof webServer.register !== 'function') return false;
        ctx.effect(
          () => registerWebApi(webServer, core, { webPath: settings.webPath, logger }),
          'dsh-company-kb: web api',
        );
        core.runtime.webApi = { state: 'registered', path: settings.webPath };
        logger.info?.(`dsh-company-kb: 面板接口已注册（${settings.webPath}）`);
        return true;
      } catch (error) {
        core.runtime.webApi = { state: 'failed', error: error.message };
        logger.warn?.(`dsh-company-kb: Web API 注册失败（工具仍可用）：${error.message}`);
        return false;
      }
    };

    if (!tryRegister()) {
      core.runtime.webApi = { state: 'waiting' };
      let attempts = 0;
      const waitTimer = setInterval(() => {
        attempts += 1;
        if (tryRegister() || attempts >= 60) {
          clearInterval(waitTimer);
          if (core.runtime.webApi.state === 'waiting') {
            core.runtime.webApi = { state: 'no-service' };
            logger.warn?.('dsh-company-kb: 等待 webServer 服务超时（30 秒），面板 API 未注册；工具仍可用');
          }
        }
      }, 500);
      if (typeof waitTimer.unref === 'function') waitTimer.unref();
      ctx.effect(() => () => clearInterval(waitTimer), 'dsh-company-kb: web api wait');
    }
  }

  // 可选的事件驱动同步（默认 off，纯手动）
  try {
    core.applyWatchMode();
  } catch (error) {
    logger.warn?.(`dsh-company-kb: autoSync 初始化失败：${error.message}`);
  }

  // 启动后只做一次"体检"：比对 stat 报告差异，不抽取、不写索引
  const timer = setTimeout(() => {
    try {
      const stale = core.staleness({ force: true });
      if (stale !== null && (stale.changed > 0 || stale.added > 0 || stale.removed > 0)) {
        logger.info?.(`dsh-company-kb: 检测到 ${stale.changed} 个文件被修改、${stale.added} 个新增、${stale.removed} 个删除；需要手动同步（面板「立即同步」或让我同步）。`);
      }
    } catch { /* 体检失败不影响使用 */ }
  }, 3000);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearTimeout(timer), 'dsh-company-kb: boot check');

  logger.info?.(`dsh-company-kb: 已加载（索引库 ${core.databasePath}，autoSync=${core.settings().autoSync}）`);
}
