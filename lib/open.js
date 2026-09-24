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
//
// 为什么用 explorer.exe 而不是 `cmd /c start`：知识库里的路径常含 "&"（例如
// "微信小程序注册&认证&备案操作步骤"），走 cmd 会被当成命令分隔符；explorer
// 直接接收命令行，不经过 shell 二次解析，最稳。
// 注意：这里是"只读打开"——只把文件交给关联程序（docx→WPS/Word，pdf→阅读器），
// 不做任何写入。

import { spawn } from 'node:child_process';

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

/** 用系统默认程序打开（等价于双击）。 */
export function openWithSystem(target) {
  launch(`"${target}"`);
}

/** 在资源管理器中打开所在文件夹并选中该文件。 */
export function revealInExplorer(target) {
  launch(`/select,"${target}"`);
}
