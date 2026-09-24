// 显式调用门禁：没有点名，就不许检索、也不许同步。
//
// 三条放行线索（任一命中即视为"用户明确要求"）：
//   ① 本会话此前已经点名启用（粘性，存在 session_state）；
//   ② 本轮直接用户消息里出现配置的触发词（"用知识库查…"），且同一子句里没有否定词；
//   ③ 消息里直接出现索引中的文件名或目录名（"按 方案模板/xxx.docx 写"）。
// 同步动作额外要求"同步意图"字样，避免模型自作主张重建索引。

import { normalize } from './segment.js';

const DENIAL = /(?:不要|不用|不需要|无需|无须|禁止|关闭|停用|停掉|别再|别用|不使用|不涉及|不包含|不含|无关|不查|不查询|不检索|不搜索|不搜|不看|不引用|no\b|don't|dont|do not|without|disable)/iu;
const SYNC_INTENT = /(?:同步|更新.{0,4}索引|重建.{0,4}索引|刷新.{0,4}索引|重建索引|刷新索引|重新.{0,4}索引|索引.{0,4}(?:更新|重建|刷新|同步)|索引一下|重新索引|sync|reindex|rebuild)/iu;

/** 本轮"直接用户消息"文本（不含插件注入、不含技能内容）。与 DSH 官方实现同源。 */
export function currentDirectUserText(agent) {
  const events = agent?.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return '';
  let turnStart = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      turnStart = index;
      break;
    }
  }
  return events.slice(turnStart + 1)
    .filter(event => event.type === 'user/message')
    .map(event => event.data)
    .filter(message => message?.source?.kind === 'user')
    .flatMap(message => message.content ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function clausesOf(text) {
  return normalize(text).toLocaleLowerCase('zh-CN').split(/[。！？!?；;\n，,、]+/u).map(clause => clause.trim()).filter(Boolean);
}

function clauseHasTrigger(clause, triggers) {
  for (const trigger of triggers) {
    if (trigger.length === 0) continue;
    const at = clause.indexOf(trigger.toLocaleLowerCase('zh-CN'));
    if (at === -1) continue;
    // 否定词必须离触发词足够近才算"否定这次调用"
    const window = clause.slice(Math.max(0, at - 24), at + trigger.length + 24);
    if (DENIAL.test(window)) continue;
    return true;
  }
  return false;
}

function clauseHasPath(clause, names) {
  for (const name of names) {
    if (name.length < 3) continue;
    if (clause.includes(name)) return true;
  }
  return false;
}

/** 判断一段用户文本是否构成一次显式调用请求。 */
export function explicitlyRequested(text, { triggers, names = [] } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  // 文件名要按同样的规则折叠：库里的名字可能用全角括号，用户输入可能用半角
  const folded = names.map(name => normalize(name).toLocaleLowerCase('zh-CN'));
  for (const clause of clausesOf(text)) {
    if (clauseHasTrigger(clause, triggers)) return true;
    if (clauseHasPath(clause, folded)) return true;
  }
  return false;
}

export function requestsSync(text) {
  return clausesOf(text).some(clause => SYNC_INTENT.test(clause) && !DENIAL.test(clause));
}

export const REFUSAL_TEXT = [
  '知识库在本会话尚未启用，因此没有执行检索。',
  '这不是错误：本插件的设计就是"只有用户明确要求时才检索公司知识库"。',
  '如果确实需要，请在消息里点名，例如："用知识库查一下农药追溯二维码的政策要求"；',
  '或者直接给出文件/目录名，例如："按 方案模板/(通用)常规项目技术方案书模板.docx 写一份 XX 方案"；',
  '也可以让用户在输入框右侧打开「知识库」开关。在此之前，请基于其它信息回答，不要反复询问是否启用知识库。',
].join('');

export function createGate(core) {
  function evaluate(agent, { requireSync = false } = {}) {
    const settings = core.settings();
    const sessionId = agent?.session?.id;
    const userText = currentDirectUserText(agent);
    const previouslyEnabled = sessionId === undefined ? false : core.sessionEnabled(sessionId);
    const triggers = settings.triggers ?? [];
    let names = [];
    if (settings.pathTriggers === true) {
      const index = core.pathTriggerNames();
      names = [...index.names, ...index.dirs];
    }
    const requested = explicitlyRequested(userText, { triggers, names });
    let enabled = previouslyEnabled;
    if (requested && !enabled && sessionId !== undefined) {
      core.setSession(sessionId, true);
      enabled = true;
    }
    const explicitOnly = settings.explicitOnly !== false;
    const allowed = explicitOnly ? enabled : true;
    const syncAllowed = allowed && (requireSync ? requestsSync(userText) : true);
    return {
      allowed,
      syncAllowed,
      enabled,
      requested,
      sessionId,
      userText,
      requireSync,
      reason: allowed
        ? (requireSync && !syncAllowed ? '需要用户明确要求同步（例如"同步一下知识库"）' : null)
        : REFUSAL_TEXT,
    };
  }

  return { evaluate };
}
