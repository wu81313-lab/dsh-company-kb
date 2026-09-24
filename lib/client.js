// 客户端 bundle（DSH Web 半边）。
//
// 契约（与已装第三方插件一致，实测得来）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... return module.exports } })
//   - React 由宿主共享提供，必须 require('react')，不能自带第二份（否则 hooks 失效）
//   - 模块导出 { apply, inject }；inject 写「服务名」
//   - 插槽注册：ctx.slots.register({ name: '<slot>', id | key, order }, Component)
//     外层用 ctx.slots.inject('<slot>', () => register(...)) 等待声明
//   - 客户端到宿主没有通用 RPC，走同源 fetch 打 /company-kb-api/*
//
// 这里刻意不引入 esbuild/tsc：整份代码是普通 JS + React.createElement，
// 出问题可以直接在浏览器里读栈、改一行刷新即可。
//
// 样式：全部走 DSH 的设计令牌（--dsw-alias-* / --dsw-specific-*），因此深浅主题
// 自动跟随，不写死颜色；令牌缺失时各条规则都有中性兜底值。

window.__ModuleLoader__.load({
  id: 'dsh-company-kb',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const API = '/company-kb-api';

    // 本面板自己的插槽 id：主面板 key 与侧边栏入口 id 必须一致，
    // 底部的入口按钮才能用 layout.selectPanel 把主区域切过来。
    const PANEL_ID = 'company-kb';

    // ------------------------------------------------------------------ 工具
    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        method: options?.method ?? 'GET',
        headers: { accept: 'application/json', 'x-dsh-company-kb-client': 'web' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text.length === 0 ? null : JSON.parse(text);
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok) throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
      return payload;
    }

    function humanBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
      if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
      if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
      return `${bytes}B`;
    }

    function humanTime(ms) {
      if (ms === null || ms === undefined) return '从未同步';
      try {
        return new Date(ms).toLocaleString('zh-CN');
      } catch {
        return String(ms);
      }
    }

    /** 结果里只展示文件名，完整相对路径另起一行灰字。 */
    function baseName(rel) {
      const text = String(rel ?? '');
      const cut = text.lastIndexOf('/');
      return cut === -1 ? text : text.slice(cut + 1);
    }

    function dirName(rel) {
      const text = String(rel ?? '');
      const cut = text.lastIndexOf('/');
      return cut === -1 ? '' : text.slice(0, cut);
    }

    // 浏览器能直接渲染的格式（面板内联预览）；doc/ppt/xls/dwg 这类交给本机程序
    const INLINE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf'];
    const isInlineType = ext => typeof ext === 'string' && INLINE_EXTS.includes(ext.toLowerCase());
    // 宿主侧能渲染成带排版 HTML 的格式（/preview）
    const PREVIEW_EXTS = ['.docx', '.xlsx', '.xlsm', '.pptx'];
    const isPreviewType = ext => typeof ext === 'string' && PREVIEW_EXTS.includes(ext.toLowerCase());
    // 旧版二进制 Office 格式：只能看抽取的文字
    const LEGACY_OFFICE_EXTS = ['.doc', '.xls', '.ppt'];
    const isLegacyOffice = ext => typeof ext === 'string' && LEGACY_OFFICE_EXTS.includes(ext.toLowerCase());

    // ------------------------------------------------------------------ 样式
    //
    // 一份静态样式表挂在 <head>，组件只写 className。
    // 每条规则都带兜底值：即使 --dsw-* 令牌在某些宿主上下文里缺失，
    // 面板也只是退化成中性灰，而不是变成不可读的透明块。
    const CSS = `
.dslkb-root{
  box-sizing:border-box;height:100%;overflow-y:auto;padding:22px 24px 36px;
  display:flex;flex-direction:column;gap:18px;align-items:stretch;
  font-family:var(--dsw-font-family,inherit);
  font-size:var(--dsw-font-s-14-font-size,14px);
  line-height:var(--dsw-font-s-14-line-height,22px);
  color:var(--dsw-alias-label-primary,inherit);
  background:var(--dsw-alias-bg-base,transparent);
  --kb-border:var(--dsw-alias-border-l1,rgba(128,128,128,.22));
  --kb-border-strong:var(--dsw-alias-border-l2,rgba(128,128,128,.34));
  --kb-surface:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));
  --kb-surface-2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.09));
  --kb-text:var(--dsw-alias-label-primary,currentColor);
  --kb-text-2:var(--dsw-alias-label-secondary,rgba(128,128,128,.92));
  --kb-text-3:var(--dsw-alias-label-tertiary,rgba(128,128,128,.72));
  --kb-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  --kb-ease:var(--ds-ease-in-out,ease);
}
.dslkb-root *{box-sizing:border-box}
.dslkb-root ::-webkit-scrollbar{width:8px;height:8px}
.dslkb-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.3));border-radius:99px}
.dslkb-root ::-webkit-scrollbar-track{background:transparent}

/* ---------------------------------------------------------------- 页头 */
.dslkb-head{display:flex;align-items:flex-start;gap:14px}
.dslkb-head-main{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1}
.dslkb-head-top{display:flex;align-items:center;gap:9px;color:var(--kb-text)}
.dslkb-title{font-size:17px;font-weight:600;letter-spacing:.01em;line-height:24px}
.dslkb-sub{font-size:12px;color:var(--kb-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dslkb-pills{display:flex;gap:8px;flex-wrap:wrap}
.dslkb-pill{
  display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;
  font-size:12px;line-height:1;white-space:nowrap;
  border:1px solid var(--kb-border);background:var(--kb-surface);color:var(--kb-text-2);
  transition:background-color .14s var(--kb-ease),border-color .14s var(--kb-ease)
}
.dslkb-pill[data-tone="ok"]{
  border-color:transparent;color:var(--dsw-alias-state-success-primary,#3f9d6d);
  background:var(--dsw-alias-state-success-tertiary,rgba(63,157,109,.13))
}
.dslkb-pill[data-tone="warn"]{
  border-color:transparent;color:var(--dsw-alias-state-warn-primary,#b7791f);
  background:var(--dsw-alias-state-warn-tertiary,rgba(183,121,31,.15))
}
.dslkb-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ---------------------------------------------------------------- 按钮 */
.dslkb-btn{
  appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;
  padding:0 13px;border-radius:9px;cursor:pointer;font:inherit;font-size:13px;font-weight:500;line-height:1;
  border:1px solid var(--kb-border-strong);background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--kb-text);
  transition:background-color .14s var(--kb-ease),border-color .14s var(--kb-ease),color .14s var(--kb-ease),opacity .14s var(--kb-ease),transform .1s var(--kb-ease)
}
.dslkb-btn:hover:not(:disabled){background:var(--kb-hover)}
.dslkb-btn:active:not(:disabled){transform:translateY(.5px)}
.dslkb-btn:disabled{opacity:.45;cursor:default}
.dslkb-btn[data-variant="primary"]{
  border-color:transparent;
  background:var(--dsw-alias-button-primary-fill,rgba(90,140,255,.2));
  color:var(--dsw-alias-label-primary-foreground,#fff)
}
.dslkb-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,rgba(90,140,255,.34))}
.dslkb-btn[data-variant="ghost"]{border-color:transparent;background:transparent;color:var(--kb-text-2)}
.dslkb-btn[data-variant="ghost"]:hover:not(:disabled){background:var(--kb-hover);color:var(--kb-text)}
.dslkb-btn[data-shape="icon"]{width:32px;padding:0}
.dslkb-btn[data-shape="sm"]{height:28px;padding:0 10px;font-size:12px;border-radius:8px}

/* ---------------------------------------------------------------- 卡片 */
.dslkb-card{
  display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:14px;
  border:1px solid var(--kb-border);background:var(--kb-surface)
}
.dslkb-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.dslkb-card-title{font-size:13px;font-weight:600;color:var(--kb-text)}
.dslkb-sep{flex:1}
.dslkb-alert{
  padding:11px 14px;border-radius:12px;font-size:13px;
  color:var(--dsw-alias-state-error-primary,#c34040);background:rgba(195,64,64,.1)
}

/* ---------------------------------------------------------------- 概览 */
.dslkb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px}
.dslkb-stat{display:flex;flex-direction:column;gap:2px;padding:11px 13px;border-radius:11px;background:var(--kb-surface-2)}
.dslkb-stat-num{font-size:20px;font-weight:600;letter-spacing:-.01em;line-height:26px;font-variant-numeric:tabular-nums}
.dslkb-stat-label{font-size:11px;color:var(--kb-text-3)}
.dslkb-meta{display:flex;flex-direction:column;gap:4px}
.dslkb-meta-row{display:flex;gap:10px;font-size:12px;min-width:0}
.dslkb-meta-key{flex:none;min-width:58px;color:var(--kb-text-3)}
.dslkb-meta-val{flex:1;min-width:0;color:var(--kb-text-2);word-break:break-all}
.dslkb-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dslkb-progress{display:flex;flex-direction:column;gap:6px}
.dslkb-bar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.22));overflow:hidden}
.dslkb-bar-fill{
  height:100%;border-radius:99px;transition:width .25s var(--kb-ease);
  background:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#5a8cff))
}
.dslkb-hint{font-size:12px;color:var(--kb-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ------------------------------------------------------------ 分段控件 */
.dslkb-seg{
  display:inline-flex;gap:2px;padding:3px;border-radius:12px;align-self:flex-start;
  border:1px solid var(--kb-border);background:var(--kb-surface-2)
}
.dslkb-seg-btn{
  appearance:none;border:none;background:transparent;color:var(--kb-text-2);cursor:pointer;
  height:28px;padding:0 16px;border-radius:9px;font:inherit;font-size:13px;font-weight:500;line-height:1;
  transition:background-color .14s var(--kb-ease),color .14s var(--kb-ease)
}
.dslkb-seg-btn:hover{color:var(--kb-text)}
.dslkb-seg-btn[aria-selected="true"]{
  background:var(--dsw-alias-bg-layer-1,#fff);color:var(--kb-text);
  box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.12))
}

/* ---------------------------------------------------------------- 表单 */
.dslkb-input{
  width:100%;height:38px;padding:0 13px;border-radius:10px;font:inherit;font-size:13px;outline:none;
  border:1px solid var(--kb-border-strong);background:var(--dsw-specific-input-major,transparent);color:var(--kb-text);
  transition:border-color .14s var(--kb-ease),background-color .14s var(--kb-ease)
}
.dslkb-input::placeholder{color:var(--kb-text-3)}
.dslkb-input:focus{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-link,#5a8cff))}
textarea.dslkb-input{height:auto;min-height:74px;padding:10px 13px;line-height:1.6;resize:vertical;
  font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px}
select.dslkb-input{cursor:pointer;padding-right:8px}
.dslkb-search{display:flex;gap:8px;align-items:center}
/* 输入框在搜索行里必须可伸缩：.dslkb-input 默认 width:100%，直接放进 flex 行会把
   右侧按钮挤到没有宽度，图标和文字叠在一起（实测就是这个现象，不是图标丑）。 */
.dslkb-search .dslkb-input{flex:1 1 auto;width:auto;min-width:0}
/* 按钮固定自身宽度、不换行，高度与输入框对齐（38px），看起来才是一条线 */
.dslkb-search .dslkb-btn{flex:0 0 auto;white-space:nowrap;height:38px;padding:0 16px;border-radius:10px;gap:7px}

/* ------------------------------------------------------ 结果 + 详情分栏 */
/* 详情不再排在结果列表下面（那样每次点开都要滚到底）。宽屏时左右分栏：
   左边结果、右边详情，各自独立滚动；窄屏自动退回单列，并由 JS 把详情滚进视野。 */
.dslkb-split{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start;margin-top:12px}
.dslkb-split[data-split="true"]{grid-template-columns:minmax(240px,36%) minmax(0,1fr)}
.dslkb-pane-list{min-width:0;display:flex;flex-direction:column;gap:8px}
.dslkb-pane-detail{min-width:0;max-height:calc(100vh - 290px);overflow:auto;overscroll-behavior:contain}
@media (max-width:1100px){
  .dslkb-split[data-split="true"]{grid-template-columns:minmax(0,1fr)}
  .dslkb-pane-detail{max-height:none}
}

/* ---------------------------------------------------------------- 结果 */
.dslkb-list{display:flex;flex-direction:column;gap:8px}
.dslkb-hit{
  display:flex;flex-direction:column;gap:4px;padding:11px 13px;border-radius:11px;cursor:pointer;
  border:1px solid var(--kb-border);background:transparent;
  transition:background-color .14s var(--kb-ease),border-color .14s var(--kb-ease)
}
.dslkb-hit:hover{background:var(--kb-hover);border-color:var(--kb-border-strong)}
.dslkb-hit[data-active="true"]{
  border-color:var(--dsw-alias-state-business-primary,#4a7dff);
  background:var(--dsw-alias-interactive-bg-active,rgba(74,125,255,.10))
}
.dslkb-hit-head{display:flex;align-items:center;gap:8px;min-width:0}
.dslkb-hit-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dslkb-hit-path{font-size:11px;color:var(--kb-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dslkb-hit-text{font-size:12px;color:var(--kb-text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dslkb-tag{
  flex:none;height:19px;display:inline-flex;align-items:center;padding:0 7px;border-radius:6px;font-size:11px;line-height:1;
  border:1px solid var(--kb-border);color:var(--kb-text-3);background:var(--kb-surface-2)
}
.dslkb-empty{
  display:flex;flex-direction:column;align-items:center;gap:6px;padding:28px 12px;text-align:center;
  font-size:13px;color:var(--kb-text-3)
}
.dslkb-empty strong{font-size:13px;font-weight:600;color:var(--kb-text-2)}

/* ---------------------------------------------------------------- 记录 */
.dslkb-timeline{display:flex;flex-direction:column}
.dslkb-log{display:flex;gap:10px;padding:10px 2px;border-bottom:1px solid var(--kb-border)}
.dslkb-log:last-child{border-bottom:none}
.dslkb-log-dot{width:7px;height:7px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-state-success-primary,#4a9d78)}
.dslkb-log[data-level="warn"] .dslkb-log-dot{background:var(--dsw-alias-state-warn-primary,#c08a20)}
.dslkb-log[data-level="error"] .dslkb-log-dot{background:var(--dsw-alias-state-error-primary,#d05252)}
.dslkb-log-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dslkb-log-time{font-size:11px;color:var(--kb-text-3);font-variant-numeric:tabular-nums}
.dslkb-log-msg{font-size:13px;color:var(--kb-text);word-break:break-word}
/* 同步记录的逐文件明细 */
.dslkb-log-files{margin-top:6px;display:flex;flex-direction:column;gap:1px}
.dslkb-log-group{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:12px;font-weight:500;color:var(--kb-text-2)}
.dslkb-log-mark{display:inline-flex;justify-content:center;width:14px;font-weight:700}
.dslkb-log-files [data-tone="add"] .dslkb-log-mark{color:var(--dsw-alias-state-success-primary,#4a9d78)}
.dslkb-log-files [data-tone="edit"] .dslkb-log-mark{color:var(--kb-text-2)}
.dslkb-log-files [data-tone="del"] .dslkb-log-mark{color:var(--dsw-alias-state-warn-primary,#c08a20)}
.dslkb-log-files [data-tone="fail"] .dslkb-log-mark{color:var(--dsw-alias-state-error-primary,#d05252)}
.dslkb-log-file{display:flex;align-items:center;gap:6px;padding:1px 0 1px 20px;font-size:12.5px;color:var(--kb-text);min-width:0}
.dslkb-log-file:hover{background:var(--kb-hover);border-radius:6px}
.dslkb-log-rel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dslkb-log-err{flex:0 1 auto;min-width:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#d05252)}
.dslkb-log-more{font-size:11.5px;color:var(--kb-text-3);padding-left:20px}

/* ---------------------------------------------------------------- 预览 */
.dslkb-preview{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:14px;
  border:1px solid var(--kb-border-strong);background:var(--kb-surface)}
.dslkb-preview-head{display:flex;align-items:center;gap:8px;min-width:0}
.dslkb-preview-name{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dslkb-pre{
  white-space:pre-wrap;word-break:break-word;margin:0;padding:12px 13px;border-radius:10px;max-height:340px;overflow:auto;
  font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.65;
  background:var(--kb-surface-2);color:var(--kb-text-2)
}
.dslkb-media{width:100%;border:1px solid var(--kb-border);border-radius:10px;background:#fff;display:block}
.dslkb-note{font-size:12px;color:var(--kb-text-3)}

/* ------------------------------------------------------------ 侧栏入口 */
/* 目标：侧栏底部三行对齐 —— 「上下文洞察」/「本地知识库」/「设置」，各自独占一行。
   做法是只把宿主的底部动作行改成竖排容器（下面第一条规则），自己再用
   align-self:stretch 撑满 —— 而不是像早先那样把自己设成 flex-basis:100%
   去挤别人：那时一旦换行没生效，整行宽的按钮就压住了「上下文洞察」的图标
   （实测的"两个按钮重叠"）。现在即便宿主的类名变了、竖排规则失效，
   也只会退回"两个紧凑按钮并排"，不会重叠。
   侧栏收成窄条时由 collapsed 规则退回图标条形态。 */
.hHd-Xa_footerActions{flex-direction:column;align-items:stretch;gap:0}
.hHd-Xa_collapsed .hHd-Xa_footerActions{flex-direction:row;align-items:center;justify-content:center;gap:0}
/* 尺寸、字号、颜色、内边距全部照「设置」按钮（.VOzbGW_trigger）对齐：
   height 42 / radius 12 / padding 0 10px 0 8px / gap 8 / font 14 / line-height 22
   / color label-primary / hover interactive-bg-hover。 */
.dslkb-foot{
  appearance:none;box-sizing:border-box;display:flex;align-items:center;gap:8px;
  align-self:stretch;height:42px;margin:4px 0;padding:0 10px 0 8px;border-radius:12px;
  border:none;background:transparent;min-width:0;overflow:hidden;white-space:nowrap;
  color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;
  cursor:pointer;transition:background-color .14s var(--kb-ease),color .14s var(--kb-ease)
}
.dslkb-foot:hover{background:var(--dsw-alias-interactive-bg-hover,var(--kb-hover))}
.dslkb-foot[data-active="true"]{
  background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary,inherit);font-weight:500
}
.dslkb-foot-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 侧栏折叠成图标条时：与「设置」的 rail 形态一致（36px 圆钮、只留图标） */
.hHd-Xa_collapsed .dslkb-foot{
  align-self:center;width:36px;height:36px;margin:0;padding:0;gap:0;justify-content:center;border-radius:50%
}
.hHd-Xa_collapsed .dslkb-foot-label{display:none}

/* ---------------------------------------------------------------- 设置 */
.dslkb-field{display:flex;align-items:center;gap:12px;min-height:34px}
.dslkb-field-label{flex:none;width:104px;font-size:13px;color:var(--kb-text-2)}
.dslkb-field-body{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.dslkb-check{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:13px;color:var(--kb-text-2);cursor:pointer}
.dslkb-check input{margin:3px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary,#4a7dff)}
.dslkb-check-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dslkb-check-title{color:var(--kb-text)}
`;

    function injectStyles() {
      const element = document.createElement('style');
      element.dataset.plugin = 'dsh-company-kb';
      element.textContent = CSS;
      document.head.appendChild(element);
      return element;
    }

    // ------------------------------------------------------------------ 图标
    function Svg(props) {
      const size = props?.size ?? 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, props?.children);
    }

    /** 知识库：一本摊开的书（左右严格对称，16px 下依然清晰）。 */
    function Icon(props) {
      return h(Svg, props,
        h('path', {
          d: 'M12 7.3C10.5 5.9 8.6 5.2 6.3 5.2c-.9 0-1.7.1-2.3.3v11.9c.6-.2 1.4-.3 2.3-.3 2.3 0 4.2.7 5.7 2 1.5-1.3 3.4-2 5.7-2 .9 0 1.7.1 2.3.3V5.5c-.6-.2-1.4-.3-2.3-.3-2.3 0-4.2.7-5.7 2Z',
        }),
        h('path', { d: 'M12 7.3v11.8' }));
    }

    function IconRefresh(props) {
      return h(Svg, props,
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }),
        h('path', { d: 'M20.5 4.5V10H15' }));
    }

    function IconSearch(props) {
      return h(Svg, props,
        h('circle', { cx: 11, cy: 11, r: 6.5 }),
        h('path', { d: 'm16 16 4 4' }));
    }

    function IconClock(props) {
      return h(Svg, props,
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 7.5V12l3 1.8' }));
    }

    function IconPlay(props) {
      return h(Svg, props,
        h('path', { d: 'M8 5.6v12.8L19 12 8 5.6Z' }));
    }

    function IconExternal(props) {
      return h(Svg, props,
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4 10.5 13.5' }),
        h('path', { d: 'M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10' }));
    }

    function IconFolder(props) {
      return h(Svg, props,
        h('path', { d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5V7.5Z' }));
    }

    function IconClose(props) {
      return h(Svg, props, h('path', { d: 'm6 6 12 12M18 6 6 18' }));
    }

    // ------------------------------------------------------- 会话输入区开关
    //
    // 会话 id 的来源在插槽契约里不是唯一的：有的插槽通过 useSessions 钩子投影
    // 当前会话，有的通过 sessionId 属性。这里只信官方通道 props.sessionId，
    // 拿不到就降级为不可点，绝不让整个面板因为一个未知字段而失效。
    function readSessionFromService(ctx) {
      try {
        const sessions = ctx.get('sessions');
        const current = sessions?.list?.getSnapshot?.()?.current
          ?? sessions?.getSnapshot?.()?.current
          ?? sessions?.current?.getSnapshot?.();
        return typeof current === 'string' && current.length > 0 ? current : undefined;
      } catch {
        return undefined;
      }
    }

    function SessionToggle(props) {
      const ctx = props?.__kbCtx;
      const sessionId = typeof props?.sessionId === 'string' && props.sessionId.length > 0
        ? props.sessionId
        : undefined;
      const [enabled, setEnabled] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        if (sessionId === undefined) {
          // 兜底：只有确实拿不到时，才试一次客户端 sessions 服务（不影响主路径）
          const guess = readSessionFromService(ctx);
          if (guess !== undefined) setError(null);
          return () => { alive = false; };
        }
        api(`/session?id=${encodeURIComponent(sessionId)}`)
          .then(value => { if (alive) setEnabled(value.enabled === true); })
          .catch(caught => { if (alive) setError(caught.message); });
        return () => { alive = false; };
      }, [sessionId, ctx]);

      const toggle = async () => {
        if (sessionId === undefined || busy) return;
        setBusy(true);
        setError(null);
        try {
          const next = await api('/session', { method: 'POST', body: { id: sessionId, enabled: enabled !== true } });
          setEnabled(next.enabled === true);
        } catch (caught) {
          setError(caught.message);
        } finally {
          setBusy(false);
        }
      };

      const label = sessionId === undefined
        ? '知识库'
        : (enabled === true ? '知识库 已开' : '知识库 已关');
      return h('button', {
        type: 'button',
        onClick: toggle,
        disabled: busy || sessionId === undefined,
        title: error ?? (sessionId === undefined
          ? '未能识别当前会话；请在消息里直接点名（例如"用知识库查…"）'
          : '切换本会话是否允许检索公司知识库（等同在消息里点名）'),
        className: 'dslkb-btn',
        style: { opacity: busy || sessionId === undefined ? 0.6 : 1 },
        'data-variant': enabled === true ? 'primary' : 'ghost',
      }, label);
    }

    // -------------------------------------------------- 侧边栏底部面板入口
    //
    // 面板入口原本挂在 sidebar.panellist（紧贴「新建会话」下方、会话列表之上），
    // 现在改挂 sidebar.footer.action —— 那一行就在侧边栏底部的「设置」按钮上方。
    // 代价是对应的主面板不再出现在 panellist 里，所以入口自己用 layout 服务切换面板。
    function openPanel(ctx) {
      try {
        const layout = ctx?.get?.('layout');
        if (layout !== undefined && typeof layout.selectPanel === 'function') {
          layout.selectPanel(PANEL_ID);
          return;
        }
        console.warn('[dsh-company-kb] 找不到 layout 服务，无法切换到知识库面板');
      } catch (error) {
        console.warn('[dsh-company-kb] 切换知识库面板失败：' + (error?.message ?? error));
      }
    }

    function FootEntryButton(props) {
      const wide = props?.wide !== false;
      // 标签始终渲染，窄条形态交给 CSS（.hHd-Xa_collapsed 下隐藏）——
      // 不用 JS 猜侧栏宽窄，避免首帧闪一下或猜错。
      return h('button', {
        type: 'button',
        className: 'dslkb-foot',
        'data-active': props?.active === true ? 'true' : undefined,
        title: '本地知识库',
        'aria-label': '本地知识库',
        'aria-current': props?.active === true ? 'page' : undefined,
        onClick: () => openPanel(props?.__kbCtx),
      },
        h(Icon, { size: 18 }),
        h('span', { className: 'dslkb-foot-label' }, '本地知识库'));
    }

    /** 能拿到 usePanelInfo 时显示选中态；拿不到就退化成普通按钮。 */
    function FootEntryActive(props) {
      const usePanelInfo = props.usePanelInfo;
      const active = usePanelInfo(info => info?.activePanelId === PANEL_ID);
      return h(FootEntryButton, { ...props, active: active === true });
    }

    function FootEntryPlain(props) {
      return h(FootEntryButton, { ...props, active: false });
    }

    function FootEntry(props) {
      return typeof props?.usePanelInfo === 'function'
        ? h(FootEntryActive, props)
        : h(FootEntryPlain, props);
    }

    // ------------------------------------------------------------- 主面板
    function MetaRow(props) {
      return h('div', { className: 'dslkb-meta-row' },
        h('span', { className: 'dslkb-meta-key' }, props.label),
        h('span', { className: 'dslkb-meta-val' }, props.value));
    }

    function Empty(props) {
      return h('div', { className: 'dslkb-empty' },
        props.icon ?? null,
        h('strong', null, props.title),
        props.hint !== undefined ? h('span', null, props.hint) : null);
    }

    // ------------------------------------------------- 同步记录的逐文件明细
    // 一条同步记录下面按「新增 / 更新 / 删除 / 失败」把文件名列出来，
    // 这样点完同步就能直接看出这次到底同步了哪些内容。
    const LOG_GROUPS = [
      { key: 'added', label: '新增', mark: '+', tone: 'add' },
      { key: 'updated', label: '更新', mark: '~', tone: 'edit' },
      { key: 'removed', label: '删除', mark: '−', tone: 'del' },
      { key: 'failed', label: '失败', mark: '!', tone: 'fail' },
    ];
    const LOG_FILES_MAX = 60;

    function LogDetails(props) {
      const [notice, setNotice] = React.useState(null);
      const details = props.details;
      if (details === null || details === undefined) return null;

      const showFile = async rel => {
        setNotice(`正在定位 ${baseName(rel)}…`);
        try {
          await api('/reveal', { method: 'POST', body: { rel } });
          setNotice(`已在资源管理器中定位：${baseName(rel)}`);
        } catch (caught) {
          setNotice(`定位失败：${caught.message}`);
        }
      };

      const rows = [];
      let shown = 0;
      let total = 0;
      for (const group of LOG_GROUPS) {
        const items = Array.isArray(details[group.key]) ? details[group.key] : [];
        total += items.length;
        if (items.length === 0) continue;
        rows.push(h('div', { key: `head-${group.key}`, className: 'dslkb-log-group', 'data-tone': group.tone },
          h('span', { className: 'dslkb-log-mark' }, group.mark),
          h('span', null, `${group.label} ${items.length} 个`)));
        for (const item of items) {
          if (shown >= LOG_FILES_MAX) break;
          shown += 1;
          const rel = typeof item === 'string' ? item : String(item?.rel ?? '');
          const note = typeof item === 'string' ? undefined : item?.note;
          const error = typeof item === 'string' ? undefined : item?.error;
          const openable = group.key === 'added' || group.key === 'updated';
          rows.push(h('div', {
            key: `${group.key}-${shown}-${rel}`,
            className: 'dslkb-log-file',
            'data-tone': group.tone,
            title: error === undefined ? rel : `${rel}：${error}`,
          },
            h('span', { className: 'dslkb-log-rel' }, rel),
            note !== undefined ? h('span', { className: 'dslkb-tag' }, note) : null,
            error !== undefined ? h('span', { className: 'dslkb-log-err' }, error) : null,
            openable
              ? h('button', {
                type: 'button',
                className: 'dslkb-btn',
                'data-shape': 'icon',
                'data-variant': 'ghost',
                title: '在文件夹中显示',
                'aria-label': '在文件夹中显示',
                onClick: () => void showFile(rel),
              }, h(IconFolder, { size: 13 }))
              : null));
        }
        if (shown >= LOG_FILES_MAX) break;
      }
      if (rows.length === 0) return null;

      return h('div', { className: 'dslkb-log-files' },
        rows,
        total > shown ? h('div', { className: 'dslkb-log-more' }, `……还有 ${total - shown} 个文件未列出`) : null,
        notice !== null ? h('div', { className: 'dslkb-log-more' }, notice) : null);
    }

    function SectionButton(props) {
      return h('button', {
        type: 'button',
        className: 'dslkb-seg-btn',
        role: 'tab',
        'aria-selected': props.active ? 'true' : 'false',
        onClick: props.onSelect,
      }, props.label);
    }

    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [progress, setProgress] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [result, setResult] = React.useState(null);
      const [searching, setSearching] = React.useState(false);
      const [openDoc, setOpenDoc] = React.useState(null);
      const [openMessage, setOpenMessage] = React.useState(null);
      // Office 文档的展示方式：'preview' = 宿主渲染的排版预览，'text' = 抽取的纯文本
      const [previewMode, setPreviewMode] = React.useState('preview');
      // 同步记录：logs 必须在这里声明。此前它在渲染里被读、在加载函数里被写，
      // 却从没进过 useState —— 点「同步记录」时渲染阶段抛 ReferenceError，
      // React 直接卸载整棵面板树，于是那一步永远是一张白屏。
      const [logs, setLogs] = React.useState(null);
      const [logsError, setLogsError] = React.useState(null);
      const [logReload, setLogReload] = React.useState(0);
      const [section, setSection] = React.useState('search');
      const previewRef = React.useRef(null);

      // 宽屏是左右分栏（结果｜详情），点结果不用滚动；窄屏退回单列，
      // 这时才需要把详情滚进视野，否则还是得手动下拉。
      React.useEffect(() => {
        if (openDoc === null) return undefined;
        const node = previewRef.current;
        if (node === null || typeof node.scrollIntoView !== 'function') return undefined;
        const narrow = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(max-width: 1100px)').matches;
        if (!narrow) return undefined;
        const timer = setTimeout(() => {
          try {
            node.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch {
            node.scrollIntoView();
          }
        }, 60);
        return () => clearTimeout(timer);
      }, [openDoc]);

      const refreshStatus = React.useCallback(async () => {
        try {
          const value = await api('/status');
          setStatus(value);
          setError(null);
        } catch (caught) {
          setError(caught.message);
        }
      }, []);

      React.useEffect(() => { void refreshStatus(); }, [refreshStatus]);

      // 同步中每 2 秒看一次进度；结束后刷新状态
      React.useEffect(() => {
        const running = progress?.running === true;
        if (!running) return undefined;
        const timer = setInterval(async () => {
          try {
            const value = await api('/progress');
            setProgress(value);
            if (value.running !== true) await refreshStatus();
          } catch { /* 下一轮再试 */ }
        }, 2000);
        return () => clearInterval(timer);
      }, [progress?.running, refreshStatus]);

      // 进入「同步记录」就拉一次，点刷新按钮也重拉
      React.useEffect(() => {
        if (section !== 'log') return undefined;
        let alive = true;
        setLogs(null);
        setLogsError(null);
        api('/log?limit=30')
          .then(value => { if (alive) setLogs(Array.isArray(value.entries) ? value.entries : []); })
          .catch(caught => { if (alive) setLogsError(caught.message); });
        return () => { alive = false; };
      }, [section, logReload]);

      const startSync = async (mode) => {
        try {
          const value = await api('/sync', { method: 'POST', body: { mode } });
          setProgress(value.started === false ? value.progress : { running: true, phase: 'starting', done: 0, total: 0 });
          setError(null);
        } catch (caught) {
          setError(caught.message);
        }
      };

      const cancelSync = async () => {
        try { await api('/cancel', { method: 'POST', body: {} }); } catch (caught) { setError(caught.message); }
      };

      const runSearch = async () => {
        if (query.trim().length === 0) return;
        setSearching(true);
        try {
          const value = await api(`/search?q=${encodeURIComponent(query.trim())}&limit=12`);
          setResult(value);
          setError(null);
        } catch (caught) {
          setError(caught.message);
        } finally {
          setSearching(false);
        }
      };

      /**
       * 打开某文件的预览。offset 是该块在整篇正文里的起始位置：
       * 面板按文件去重后，用它的最佳块位置直接把预览定位到命中处，
       * 而不是每次都从文档开头读（那样同一文件的第二条命中看起来就是"重复"）。
       */
      const openDocument = async (rel, offset = 0) => {
        try {
          const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
          const value = await api(`/doc?rel=${encodeURIComponent(rel)}${start > 0 ? `&offset=${start}` : ''}&limit=8000`);
          setOpenDoc(value);
          setOpenMessage(null);
        } catch (caught) {
          setError(caught.message);
        }
      };

      // 交给系统默认程序打开 / 在资源管理器中定位
      const callSystem = async endpoint => {
        if (openDoc === null || openDoc.rel === undefined) return;
        setOpenMessage('正在调用系统程序…');
        try {
          const value = await api(endpoint, { method: 'POST', body: { rel: openDoc.rel } });
          setOpenMessage(value.revealed === true
            ? '已在资源管理器中定位该文件'
            : `已交给系统默认程序打开${value.path ? `：${value.path}` : ''}`);
        } catch (caught) {
          setOpenMessage(`打开失败：${caught.message}`);
        }
      };

      const stats = status?.stats;
      const stale = status?.stale;
      const staleCount = stale === undefined || stale === null ? 0 : (stale.changed ?? 0) + (stale.added ?? 0) + (stale.removed ?? 0);
      const running = progress?.running === true || status?.sync?.running === true;
      const active = progress?.running === true ? progress : status?.sync;
      const percent = active && active.total > 0 ? Math.round((active.done / active.total) * 100) : 0;
      const rootPath = status?.roots?.[0]?.path;
      const subtitle = rootPath !== undefined
        ? `索引目录：${rootPath}`
        : (status?.databasePath !== undefined ? `索引库：${status.databasePath}` : '正在读取状态…');

      const meta = (status?.stats?.failures ?? []).length;

      // 同一文件的多个命中合并成一条，并标注"另有 N 处"。
      // 检索单元是"块"（一份长文档可能有 2-3 块命中），面板里把同一个文件名
      // 重复列出来既占位置又没意义——点开看到的是同一篇文档。
      const fileHits = [];
      if (result !== null) {
        const seen = new Map();
        for (const hit of result.hits) {
          const existing = seen.get(hit.rel);
          if (existing === undefined) {
            const merged = { ...hit, extraHits: 0 };
            seen.set(hit.rel, merged);
            fileHits.push(merged);
          } else {
            existing.extraHits += 1;
          }
        }
      }

      return h('div', { className: 'dslkb-root' },

        // ---------------------------------------------------------- 页头
        h('div', { className: 'dslkb-head' },
          h('div', { className: 'dslkb-head-main' },
            h('div', { className: 'dslkb-head-top' },
              h(Icon, { size: 18 }),
              h('span', { className: 'dslkb-title' }, '本地知识库')),
            h('div', { className: 'dslkb-sub', title: rootPath ?? '' }, subtitle),
            h('div', { className: 'dslkb-pills' },
              h('span', { className: 'dslkb-pill' },
                h('span', { className: 'dslkb-dot' }),
                status?.settings?.autoSync === 'watch' ? '自动监听' : '手动同步'),
              h('span', { className: 'dslkb-pill', 'data-tone': staleCount > 0 ? 'warn' : 'ok' },
                h('span', { className: 'dslkb-dot' }),
                staleCount > 0 ? `有 ${staleCount} 个变化待同步` : '索引与磁盘一致'))),
          h('button', {
            type: 'button',
            className: 'dslkb-btn',
            'data-variant': 'ghost',
            'data-shape': 'icon',
            title: '刷新状态',
            'aria-label': '刷新状态',
            onClick: () => void refreshStatus(),
          }, h(IconRefresh, { size: 16 }))),

        error !== null && h('div', { className: 'dslkb-alert' },
          `面板连接失败：${error}（若刚安装插件，请重启 DSH 后刷新页面）`),

        // ---------------------------------------------------------- 概览
        h('div', { className: 'dslkb-card' },
          h('div', { className: 'dslkb-card-head' },
            h('span', { className: 'dslkb-card-title' }, '索引概况'),
            h('span', { className: 'dslkb-sep' }),
            running ? h('span', { className: 'dslkb-hint' }, '同步进行中') : null),

          !status || stats === undefined
            ? h('div', { className: 'dslkb-note' }, '正在读取状态…')
            : h(React.Fragment, null,
              status.built !== true
                ? h('div', { className: 'dslkb-note' }, '尚未建立索引 —— 点「立即同步」开始（首次约 1–5 分钟，含扫描件 OCR）')
                : h('div', { className: 'dslkb-stats' },
                  h('div', { className: 'dslkb-stat' },
                    h('span', { className: 'dslkb-stat-num' }, String(stats.docs)),
                    h('span', { className: 'dslkb-stat-label' }, '已索引文件')),
                  h('div', { className: 'dslkb-stat' },
                    h('span', { className: 'dslkb-stat-num' }, stats.chars.toLocaleString('en-US')),
                    h('span', { className: 'dslkb-stat-label' }, '字符')),
                  h('div', { className: 'dslkb-stat' },
                    h('span', { className: 'dslkb-stat-num' }, String(stats.chunks)),
                    h('span', { className: 'dslkb-stat-label' }, '检索片段'))),

              h('div', { className: 'dslkb-meta' },
                h(MetaRow, { label: '上次同步', value: humanTime(status.lastSyncAt) }),
                status.lastSummary && h(MetaRow, {
                  label: '上次结果',
                  value: `新增 ${status.lastSummary.added}｜更新 ${status.lastSummary.updated}｜删除 ${status.lastSummary.removed}`
                    + `｜失败 ${status.lastSummary.failed}｜耗时 ${(status.lastSummary.durationMs / 1000).toFixed(1)}s`,
                }),
                status.lastSummary
                  && (status.lastSummary.added + status.lastSummary.updated + status.lastSummary.removed + status.lastSummary.failed) > 0
                  && h(MetaRow, {
                    label: '本次变化',
                    // 看完同步就想知道"到底同步了哪些内容"，这里直接跳到同步记录
                    value: h('button', {
                      type: 'button',
                      className: 'dslkb-btn',
                      'data-shape': 'sm',
                      'data-variant': 'ghost',
                      onClick: () => { setSection('log'); setLogReload(value => value + 1); },
                    }, h(IconClock, { size: 13 }), '查看同步了哪些文件'),
                  }),
                status.built === true && h(MetaRow, {
                  label: '索引库',
                  value: `${humanBytes(stats.databaseBytes)}｜${status.databasePath}`,
                }),
                status.capabilities && h(MetaRow, {
                  label: '能力',
                  value: `OCR：${status.capabilities.ocr ? `可用（${(status.capabilities.ocrLangs ?? []).join('/')}）` : '不可用'}`
                    + `｜Word 提取：${status.capabilities.word ? '可用' : '不可用'}`,
                }),
                meta > 0 && h(MetaRow, { label: '未抽取', value: `${meta} 个文件没有正文（见「同步记录」）` })),

              h('div', { className: 'dslkb-actions' },
                h('button', {
                  type: 'button',
                  className: 'dslkb-btn',
                  'data-variant': 'primary',
                  disabled: running,
                  title: '立即同步：只处理变化的文件（平时用这个）',
                  onClick: () => void startSync('now'),
                }, h(IconPlay, { size: 15 }), running ? '同步中…' : '立即同步'),
                h('button', {
                  type: 'button',
                  className: 'dslkb-btn',
                  disabled: running,
                  title: '重建索引：清空索引后把所有文件重新抽取一遍（不动原文件；改过影响索引的设置、或怀疑索引不一致时用）',
                  onClick: () => void startSync('rebuild'),
                }, '重建索引'),
                running && h('button', {
                  type: 'button',
                  className: 'dslkb-btn',
                  'data-variant': 'ghost',
                  onClick: () => void cancelSync(),
                }, '中止')),

              running && h('div', { className: 'dslkb-progress' },
                h('div', { className: 'dslkb-bar' },
                  h('div', { className: 'dslkb-bar-fill', style: { width: `${percent > 0 ? percent : 3}%` } })),
                h('div', { className: 'dslkb-hint' },
                  `${active?.phase ?? '同步'} ${active?.done ?? 0}/${active?.total ?? 0}${active?.current ? `｜${active.current}` : ''}`)))),

        // ---------------------------------------------------------- 分区
        h('div', { className: 'dslkb-seg', role: 'tablist' },
          h(SectionButton, { label: '搜索', active: section === 'search', onSelect: () => setSection('search') }),
          h(SectionButton, { label: '同步记录', active: section === 'log', onSelect: () => setSection('log') })),

        // ---------------------------------------------------------- 搜索
        section === 'search' && h('div', { className: 'dslkb-card' },
          h('div', { className: 'dslkb-search' },
            h('input', {
              className: 'dslkb-input',
              value: query,
              placeholder: '例如：农药追溯二维码政策 / 袋线瓶线报价 / PDA 出库流程',
              onChange: event => setQuery(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') void runSearch(); },
            }),
            h('button', {
              type: 'button',
              className: 'dslkb-btn',
              'data-variant': 'primary',
              onClick: () => void runSearch(),
              disabled: searching || query.trim().length === 0,
            }, h(IconSearch, { size: 14 }), searching ? '检索中…' : '检索')),

          h('div', {
            className: 'dslkb-split',
            'data-split': openDoc !== null ? 'true' : 'false',
          },
          h('div', { className: 'dslkb-pane-list' },
            result !== null && h(React.Fragment, null,
              h('div', { className: 'dslkb-note' },
                `命中 ${result.hits.length} 处，覆盖 ${fileHits.length} 个文件（候选 ${result.candidates}）｜查询词：`
                + ([...(result.plan?.phrases ?? []), ...(result.plan?.terms ?? [])].join(' / ') || '—')),
              result.hits.length === 0
                ? h(Empty, {
                  title: '没有命中',
                  hint: '换同义词再试，或在消息里直接点名要查的文件名。',
                })
                : h('div', { className: 'dslkb-list' },
                  fileHits.map(hit => h('div', {
                    key: hit.rel,
                    className: 'dslkb-hit',
                    'data-active': openDoc !== null && openDoc.rel === hit.rel ? 'true' : undefined,
                    onClick: () => void openDocument(hit.rel, hit.charStart),
                    title: hit.rel,
                  },
                    h('div', { className: 'dslkb-hit-head' },
                      h(Icon, { size: 14 }),
                      h('span', { className: 'dslkb-hit-name' }, baseName(hit.rel)),
                      hit.textSource === 'ocr' ? h('span', { className: 'dslkb-tag' }, 'OCR') : null,
                      hit.page === undefined ? null : h('span', { className: 'dslkb-tag' }, `第 ${hit.page} 页`),
                      hit.extraHits > 0 ? h('span', { className: 'dslkb-tag' }, `另有 ${hit.extraHits} 处`) : null),
                    dirName(hit.rel).length > 0 ? h('div', { className: 'dslkb-hit-path' }, dirName(hit.rel)) : null,
                    hit.heading ? h('div', { className: 'dslkb-hit-path' }, hit.heading) : null,
                    h('div', { className: 'dslkb-hit-text' }, hit.snippet)))))),
          openDoc !== null && h('div', { className: 'dslkb-preview dslkb-pane-detail', ref: previewRef },
            h('div', { className: 'dslkb-preview-head' },
              h(Icon, { size: 14 }),
              h('span', { className: 'dslkb-preview-name', title: openDoc.rel ?? '' },
                openDoc.rel ?? openDoc.message ?? ''),
              openDoc.found === true && openDoc.rel !== undefined && h('button', {
                type: 'button',
                className: 'dslkb-btn',
                'data-shape': 'sm',
                'data-variant': 'primary',
                onClick: () => void callSystem('/open'),
              }, h(IconExternal, { size: 14 }), '用本机程序打开'),
              openDoc.found === true && openDoc.rel !== undefined && h('button', {
                type: 'button',
                className: 'dslkb-btn',
                'data-shape': 'sm',
                'data-variant': 'ghost',
                onClick: () => void callSystem('/reveal'),
              }, h(IconFolder, { size: 14 }), '在文件夹中显示'),
              h('button', {
                type: 'button',
                className: 'dslkb-btn',
                'data-shape': 'sm',
                'data-variant': 'ghost',
                title: '关闭预览',
                'aria-label': '关闭预览',
                onClick: () => { setOpenDoc(null); setOpenMessage(null); },
              }, h(IconClose, { size: 14 }))),
            h('div', { className: 'dslkb-note' }, openDoc.found === true
              ? `状态 ${openDoc.status}｜来源 ${openDoc.textSource}｜共 ${openDoc.chars} 字${openDoc.pages ? `｜${openDoc.pages} 页` : ''}`
                + `${openDoc.path ? `｜${openDoc.path}` : ''}`
              : '索引里没有这个文件'),
            openMessage !== null && h('div', { className: 'dslkb-note' }, openMessage),
            // 图片 / PDF 直接在面板里看原文件
            openDoc.found === true && isInlineType(openDoc.ext)
              ? (openDoc.ext === '.pdf'
                ? h('iframe', {
                  className: 'dslkb-media',
                  src: `${API}/raw?rel=${encodeURIComponent(openDoc.rel)}`,
                  style: { height: '520px' },
                  title: openDoc.rel,
                })
                : h('img', {
                  className: 'dslkb-media',
                  src: `${API}/raw?rel=${encodeURIComponent(openDoc.rel)}`,
                  alt: openDoc.rel,
                  style: { maxHeight: '440px', objectFit: 'contain' },
                }))
              : null,
            // Office 文档：插件自己解析出带排版的 HTML（表格是真的表格、图片按原位），
            // 也可以切回"抽取的纯文本"。旧版 .doc/.xls 是二进制格式，只能看文字。
            openDoc.found === true && isLegacyOffice(openDoc.ext)
              ? h('div', { className: 'dslkb-note' }, '旧版 Office 格式（.doc/.xls/.ppt）只能显示抽取的文字；排版预览请用「用本机程序打开」，或把文件另存为 .docx/.xlsx/.pptx。')
              : null,
            openDoc.found === true && isPreviewType(openDoc.ext)
              ? h('div', { className: 'dslkb-seg', role: 'tablist', style: { marginTop: '6px' } },
                h('button', {
                  type: 'button',
                  className: 'dslkb-seg-btn',
                  role: 'tab',
                  'aria-selected': previewMode === 'preview' ? 'true' : 'false',
                  onClick: () => setPreviewMode('preview'),
                }, '排版预览'),
                h('button', {
                  type: 'button',
                  className: 'dslkb-seg-btn',
                  role: 'tab',
                  'aria-selected': previewMode === 'text' ? 'true' : 'false',
                  onClick: () => setPreviewMode('text'),
                }, '抽取正文'))
              : null,
            openDoc.found === true && isPreviewType(openDoc.ext) && previewMode === 'preview'
              ? h('iframe', {
                className: 'dslkb-media',
                src: `${API}/preview?rel=${encodeURIComponent(openDoc.rel)}`,
                style: { height: '620px' },
                title: `${openDoc.rel} 预览`,
                // 只允许同源（图片要走同源 /media），脚本/表单/弹窗一律禁止；
                // 宿主侧还会带 CSP 再兜一层
                sandbox: 'allow-same-origin',
              })
              : h('pre', { className: 'dslkb-pre' },
                openDoc.text && openDoc.text.length > 0 ? openDoc.text : (openDoc.message ?? ''))))),

        // ------------------------------------------------------ 同步记录
        section === 'log' && h('div', { className: 'dslkb-card' },
          h('div', { className: 'dslkb-card-head' },
            h(IconClock, { size: 16 }),
            h('span', { className: 'dslkb-card-title' }, '同步记录'),
            h('span', { className: 'dslkb-sep' }),
            h('button', {
              type: 'button',
              className: 'dslkb-btn',
              'data-shape': 'icon',
              'data-variant': 'ghost',
              title: '刷新记录',
              'aria-label': '刷新记录',
              onClick: () => setLogReload(value => value + 1),
            }, h(IconRefresh, { size: 15 }))),
          h('div', { className: 'dslkb-note' }, '每一次手动同步都记在这里；本插件没有任何定时同步。'),

          logsError !== null
            ? h('div', { className: 'dslkb-alert' }, `读取同步记录失败：${logsError}`)
            : (logs === null
              ? h('div', { className: 'dslkb-note' }, '正在读取…')
              : (logs.length === 0
                ? h(Empty, { title: '还没有同步记录', hint: '点上面的「立即同步」跑一次就会出现在这里。' })
                : h('div', { className: 'dslkb-timeline' },
                  logs.map((entry, index) => h('div', {
                    key: `${entry.ts}-${index}`,
                    className: 'dslkb-log',
                    'data-level': entry.level,
                  },
                    h('span', { className: 'dslkb-log-dot' }),
                    h('div', { className: 'dslkb-log-body' },
                      h('span', { className: 'dslkb-log-time' }, `${humanTime(entry.ts)}｜${entry.level}`),
                      h('span', { className: 'dslkb-log-msg' }, entry.message),
                      h(LogDetails, { details: entry.details }))))))),

          h('div', { className: 'dslkb-card-head', style: { marginTop: '4px' } },
            h('span', { className: 'dslkb-card-title' }, '未抽取正文的文件')),
          (status?.stats?.failures ?? []).length === 0
            ? h('div', { className: 'dslkb-note' }, '没有失败项。')
            : h('div', { className: 'dslkb-list' },
              (status?.stats?.failures ?? []).slice(0, 20).map(item => h('div', {
                key: item.rel,
                className: 'dslkb-hit',
                style: { cursor: 'default' },
              },
                h('div', { className: 'dslkb-hit-head' },
                  h('span', { className: 'dslkb-hit-name' }, baseName(item.rel)),
                  h('span', { className: 'dslkb-tag' }, item.status)),
                h('div', { className: 'dslkb-hit-path' }, item.rel),
                item.error ? h('div', { className: 'dslkb-hit-text' }, item.error) : null))))
      );
    }

    // ------------------------------------------------------------- 设置页
    function SettingsPage() {
      const [settings, setSettings] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

      React.useEffect(() => {
        api('/settings')
          .then(value => setSettings(value.settings))
          .catch(caught => setMessage(`读取设置失败：${caught.message}`));
      }, []);

      const patch = async update => {
        setSaving(true);
        try {
          const value = await api('/settings', { method: 'POST', body: { patch: update } });
          setSettings(value.settings);
          setMessage('已保存（立即生效，无需重启）');
        } catch (caught) {
          setMessage(`保存失败：${caught.message}`);
        } finally {
          setSaving(false);
        }
      };

      if (settings === null) {
        return h('div', { className: 'dslkb-root' },
          h('div', { className: 'dslkb-head-top' }, h(Icon, { size: 18 }), h('span', { className: 'dslkb-title' }, '本地知识库设置')),
          h('div', { className: 'dslkb-note' }, message ?? '正在读取设置…'));
      }

      const check = (key, label, hint, invert = false) => h('label', { className: 'dslkb-check' },
        h('input', {
          type: 'checkbox',
          checked: invert ? settings[key] !== false : settings[key] === true,
          onChange: event => void patch({ [key]: event.target.checked }),
        }),
        h('span', { className: 'dslkb-check-text' },
          h('span', { className: 'dslkb-check-title' }, label),
          hint ? h('span', { className: 'dslkb-note' }, hint) : null));

      return h('div', { className: 'dslkb-root' },
        h('div', { className: 'dslkb-head' },
          h('div', { className: 'dslkb-head-main' },
            h('div', { className: 'dslkb-head-top' }, h(Icon, { size: 18 }), h('span', { className: 'dslkb-title' }, '本地知识库设置')),
            h('div', { className: 'dslkb-sub' }, '只读索引本地资料；插件永不修改被索引的目录。')),
          saving ? h('span', { className: 'dslkb-pill' }, '保存中…') : null),
        message !== null && h('div', { className: 'dslkb-note' }, message),

        h('div', { className: 'dslkb-card' },
          h('div', { className: 'dslkb-card-head' }, h('span', { className: 'dslkb-card-title' }, '索引根目录')),
          h('div', { className: 'dslkb-note' }, '每行一个目录；失焦即保存。'),
          h('textarea', {
            className: 'dslkb-input',
            defaultValue: (settings.roots ?? []).join('\n'),
            onBlur: event => {
              const roots = event.target.value.split('\n').map(line => line.trim()).filter(Boolean);
              void patch({ roots });
            },
          })),

        h('div', { className: 'dslkb-card' },
          h('div', { className: 'dslkb-card-head' }, h('span', { className: 'dslkb-card-title' }, '同步与检索')),

          h('div', { className: 'dslkb-field' },
            h('span', { className: 'dslkb-field-label' }, '同步方式'),
            h('div', { className: 'dslkb-field-body' },
              h('select', {
                className: 'dslkb-input',
                value: settings.autoSync,
                onChange: event => void patch({ autoSync: event.target.value }),
              },
                h('option', { value: 'off' }, '纯手动（默认，只有点按钮/明确要求才同步）'),
                h('option', { value: 'watch' }, '文件变化时自动同步（事件驱动，无定时器）')))),

          check('stalenessHint', '打开面板时体检并提示"有多少文件变了"'),
          check('explicitOnly', '只在用户点名时允许检索（显式调用）', undefined, true),
          check('pathTriggers', '消息里出现知识库内的文件名/目录名也算点名', undefined, true),
          check('trigram', '启用子串索引（trigram，中文片段检索更全，占用更大）'),

          h('div', { className: 'dslkb-field' },
            h('span', { className: 'dslkb-field-label' }, '旧版 .doc/.xls'),
            h('div', { className: 'dslkb-field-body' },
              h('select', {
                className: 'dslkb-input',
                value: settings.legacyDoc,
                onChange: event => void patch({ legacyDoc: event.target.value }),
              },
                h('option', { value: 'word-com' }, '用本机 Word 提取正文（会短暂启动 Word）'),
                h('option', { value: 'skip' }, '跳过，仅按文件名检索')))),

          h('div', { className: 'dslkb-field' },
            h('span', { className: 'dslkb-field-label' }, '触发词'),
            h('div', { className: 'dslkb-field-body' },
              h('input', {
                className: 'dslkb-input',
                defaultValue: (settings.triggers ?? []).join(','),
                placeholder: '用逗号分隔',
                onBlur: event => {
                  const triggers = event.target.value.split(/[,，]/u).map(item => item.trim()).filter(Boolean);
                  void patch({ triggers });
                },
              }))),

          h('div', { className: 'dslkb-note' },
            `OCR 每页宽度 ${settings.ocrWidth}px｜单文件最多 OCR ${settings.maxOcrPagesPerFile} 页｜单文件解析上限 ${humanBytes(settings.maxFileBytes)}`)),
      );
    }

    // ------------------------------------------------------------ 插件装配
    const inject = ['slots'];

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined) return;

      ctx.effect(() => {
        const element = injectStyles();
        return () => element.remove();
      }, 'dsh-company-kb: styles');

      // 每个挂载点都各自兜错：任何一个插槽的注册失败（选项不符、槽位改名等）
      // 都不能连累其它挂载点，更不能让整个客户端半边加载失败。
      const mount = (slot, options, Component, label) => ctx.effect(() => slots.inject(slot, () => {
        try {
          return slots.register(options, Component);
        } catch (error) {
          console.error('[dsh-company-kb] 注册插槽失败 ' + slot + '：' + (error && error.message ? error.message : error));
          return () => {};
        }
      }), label);

      // 侧边栏入口：挂在底部动作行（紧邻「设置」按钮上方）。
      // 这里不再注册 sidebar.panellist —— 那个位置在「新建会话」与会话列表之间，
      // 用户要求把它挪到下面。入口的点击行为由 layout.selectPanel 接管。
      mount('sidebar.footer.action', {
        name: 'sidebar.footer.action',
        id: PANEL_ID,
        // 大 order：在底部动作行里排到最后，也就是贴着下方的「设置」按钮
        order: 100,
        label: () => '本地知识库',
      }, props => h(FootEntry, { ...props, __kbCtx: ctx }), 'dsh-company-kb: footer entry');

      mount('main', {
        name: 'main',
        key: PANEL_ID,
      }, () => h(Panel), 'dsh-company-kb: main panel');

      mount('conversation.input.right', {
        name: 'conversation.input.right',
        id: PANEL_ID,
        order: 5,
        label: () => '知识库',
        // 会话作用域插槽的官方参数注入：回调收到当前会话 id，返回的对象成为组件 props
        inject: sessionId => ({ sessionId }),
      }, props => h(SessionToggle, { ...props, __kbCtx: ctx }), 'dsh-company-kb: session toggle');

      mount('settings.plugins.tab', {
        name: 'settings.plugins.tab',
        id: PANEL_ID,
        order: 12,
        label: () => '本地知识库',
      }, () => h(SettingsPage), 'dsh-company-kb: settings tab');
    }

    // LogDetails / LOG_GROUPS 一并导出：只给单测用（浏览器里只用 apply 与 inject）
    module.exports = { apply, inject, LogDetails, LOG_GROUPS, LOG_FILES_MAX };
    return module.exports;
  },
});
