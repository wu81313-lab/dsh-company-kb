// 提示段：每个模型步骤注入一小段状态，让模型知道"知识库现在能用/不能用/还没建库"。
// 未启用时明确要求不要主动检索、不要反复询问、更不要自行同步。

export function buildStateText(core, agent) {
  const settings = core.settings();
  const stats = core.store.stats();
  const built = stats.docs > 0;
  const lastSyncAt = core.store.getMeta('lastSyncAt');
  const sessionId = agent?.session?.id;
  const enabled = sessionId === undefined ? false : core.sessionEnabled(sessionId);
  const stale = settings.stalenessHint === true ? core.staleness() : null;

  const lines = [];
  lines.push('【本地知识库 dsh-company-kb】');
  lines.push(`索引：${built ? `${stats.docs} 个文件 / ${stats.chars.toLocaleString('en-US')} 字` : '尚未建立'}` +
    `${lastSyncAt === undefined ? '（从未同步）' : `（上次同步 ${new Date(Number(lastSyncAt)).toLocaleString('zh-CN')}）`}`);
  if (built && stale !== null && stale !== undefined && (stale.changed > 0 || stale.added > 0 || stale.removed > 0)) {
    lines.push(`注意：索引之后检测到变化（修改 ${stale.changed}、新增 ${stale.added}、删除 ${stale.removed}），需要用户手动同步后才是最新。`);
  }

  if (settings.explicitOnly === false) {
    lines.push('状态：未启用显式限制，可随时使用 kb_search / kb_read / kb_list。');
  } else if (enabled) {
    lines.push('状态：本会话已启用（用户已点名或打开了开关）。');
    lines.push('流程：kb_search 检索 → kb_read 读原文 → 引用时给出文件相对路径与标题；资料不足要明说，不要编造。');
  } else {
    lines.push('状态：本会话未启用。不要调用 kb_search / kb_read / kb_list，也不要自行同步或反复询问是否启用。');
    lines.push('只有用户在消息里点名（例如"用知识库查…"）或给出知识库内的文件名/目录名，或打开输入框右侧的「知识库」开关后，才可以使用。');
  }
  if (!built) {
    lines.push('索引为空：需要用户在左栏「本地知识库」面板点「立即同步」，或明确要求同步。');
  }
  return lines.join('\n');
}
