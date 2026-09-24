// 诊断脚本：验证 lib/open.js 的两个动作真的会弹出窗口。
//
// 用法：node test/reveal-probe.mjs "<文件绝对路径>" <open|reveal|plain|detached|folder|ps>
//   open / reveal 走 lib/open.js 的真实实现；其余模式是排查历史问题用的对照。
// 必须用文件传参，别用 PowerShell 管道喂 stdin —— 管道按本地代码页转码，
// 中文路径会变乱码（曾因此误判"无效"）。配合 PowerShell 的窗口枚举即可验证。

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { openWithSystem, revealInExplorer } from '../lib/open.js';

const target = process.argv[2];
const mode = process.argv[3] ?? 'reveal';
if (typeof target !== 'string' || target.length === 0) {
  console.error('缺少目标文件路径');
  process.exit(2);
}

const base = { stdio: 'ignore', windowsHide: false };

if (mode === 'open') {
  openWithSystem(target);
  console.log(`mode=open target=${target} exists=${existsSync(target)}`);
  // 给 explorer 一点时间真正把子进程/窗口建起来，再退出（否则容易抢跑）
  await new Promise(resolve => setTimeout(resolve, 1500));
  process.exit(0);
}
if (mode === 'reveal') {
  revealInExplorer(target);
  console.log(`mode=reveal target=${target} exists=${existsSync(target)}`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  process.exit(0);
}

let child;
switch (mode) {
  case 'plain':
    child = spawn('explorer.exe', [`/select,${target}`], { ...base, detached: false });
    break;
  case 'detached':
    child = spawn('explorer.exe', [`/select,${target}`], { ...base, detached: true });
    break;
  case 'folder':
    child = spawn('explorer.exe', [existsSync(target) && statSync(target).isFile() ? dirname(target) : target], {
      ...base,
      detached: false,
    });
    break;
  case 'ps': {
    const script = `Start-Process -FilePath explorer.exe -ArgumentList '/select,"${target.replaceAll("'", "''")}"'`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      ...base,
      detached: false,
    });
    break;
  }
  default:
    console.error(`未知模式：${mode}`);
    process.exit(2);
}
console.log(`mode=${mode} pid=${child.pid}`);
