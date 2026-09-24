// 调用系统默认程序打开文件 / 在资源管理器中定位。
//
// 两个坑都是实测出来的（见 test/reveal-probe.mjs，可复现）：
//  1) 不能用 Node 的自动参数加引号。`spawn('explorer.exe', ['/select,' + path])`
//     会让 libuv 把「/select,路径」整串包进引号，explorer 解析不了——现象是
//     打开了「文档」或者干脆没有窗口。正确做法是手动给出文档规定的形式
//     `/select,"完整路径"`，并用 windowsVerbatimArguments 原样传给系统。
//  2) 不能 detached。detached 创建的进程不弹窗口。
//  3) windowsHide 必须为 false —— /select 的窗口是 explorer 自己创建的，
//     隐藏了就等于"点了没反应"。
//  4) 窗口开出来了，但**在浏览器后面**：Windows 不允许后台进程抢前台，
//     所以「在文件夹中显示」看起来像没反应。定位之后再用
//     focus-helper.ps1 把那个窗口提到前台（AttachThreadInput 提权）。
//
// 为什么用 explorer.exe 而不是 `cmd /c start`：知识库里的路径常含 "&"（例如
// "微信小程序注册&认证&备案操作步骤"），走 cmd 会被当成命令分隔符；explorer
// 直接接收命令行，不经过 shell 二次解析，最稳。
// 注意：这里是"只读打开"——只把文件交给关联程序（docx→WPS/Word，pdf→阅读器），
// 不做任何写入。

import { spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOCUS_HELPER = fileURLToPath(new URL('./focus-helper.ps1', import.meta.url));

function launch(verbatimArg) {
  const child = spawn('explorer.exe', [verbatimArg], {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  child.unref();
  return child;
}

/**
 * 把资源管理器窗口提到前台。资源管理器窗口标题就是所在文件夹的名字，
 * 因此用文件夹名去匹配。纯粹是体验优化：失败也不影响"已经定位好"这件事。
 */
function focusExplorerWindow(folderName) {
  if (typeof folderName !== 'string' || folderName.length === 0) return;
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', FOCUS_HELPER,
      '-Title', folderName,
      '-TimeoutSeconds', '8',
    ], { stdio: 'ignore', windowsHide: true, detached: false });
    child.unref();
  } catch { /* 提不到前台就保持原样 */ }
}

/** explorer 定位参数：引号必须手动带上，且整串原样传（见文件头注释 1）。 */
export function revealArgument(target) {
  return `/select,"${target}"`;
}

/** 交给关联程序的参数：整串带引号，避免路径里的空格被拆开。 */
export function openArgument(target) {
  return `"${target}"`;
}

/** 用系统默认程序打开（等价于双击）。 */
export function openWithSystem(target) {
  launch(openArgument(target));
}

/** 在资源管理器中打开所在文件夹、选中该文件，并把窗口提到前台。 */
export function revealInExplorer(target) {
  launch(revealArgument(target));
  focusExplorerWindow(basename(dirname(target)));
}
