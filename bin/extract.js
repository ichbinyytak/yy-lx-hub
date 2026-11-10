#!/usr/bin/env node
'use strict';
// 命令行 / GitHub Actions 无状态单次执行入口：
// 1. 支持 GITHUB_TOKEN 环境变量自动注入，突破 API 限流；
// 2. 实时输出全量进度与实测日志至 stdout；
// 3. 实现「去死留活 + 增量纳新」：保留历史活源与 API 复测，淘汰连续失效>=3次的源；
// 4. 导出带「平台标签」的 sources.zip、静态看板 data.json 与黄金 API extracted_apis.json。

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const core = require('../lib/core');
const radar = require('../lib/radar');
const exporter = require('../lib/exporter');

const args = process.argv.slice(2);
const radarOnly = args.indexOf('--radar-only') >= 0;

function pad2(n) { return ('0' + n).slice(-2); }
function tsPrefix() {
  const d = new Date();
  return '[' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + ']';
}

(async function main() {
  const db = store.getDb();
  if (process.env.GITHUB_TOKEN) db.config.ghToken = process.env.GITHUB_TOKEN;

  store.setLogListener(function (line) {
    console.log(tsPrefix(), line.msg);
  });

  if (radarOnly) {
    console.log('=== yy-lx-hub 动态 30 天 GitHub 雷达探测 ===');
    const r = await radar.scanActiveRepos({ cfg: db.config, days: db.config.radarDays || 30, log: console.log });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  const t0 = Date.now();
  console.log('=== yy-lx-hub 全流程巡航与验证启动 ===');
  console.log('运行模式:', process.env.CI ? 'GitHub Actions / CI' : '本地终端', '| GITHUB_TOKEN:', db.config.ghToken ? '已配置' : '未配置(匿名限频)');
  console.log('存量档案:', db.entries.length, '个历史脚本 |', (db.apiPool || []).length, '条历史 API');

  db.config.autoCheck = true;
  const res = await core.crawlAll(core.DEFAULT_UA, process.env.CI ? 'Actions' : 'CLI');
  if (res.error) {
    console.error('❌ 运行失败:', res.error);
    store.saveNow();
    process.exit(1);
  }

  // 产出带 [平台标签] 文件名与 00_平台适用清单.txt 的 sources.zip
  const built = exporter.buildSourcesZip(db.entries, store);
  if (built.zipBuffer) {
    const zipPath = path.join(__dirname, '..', 'public', 'sources.zip');
    fs.writeFileSync(zipPath, built.zipBuffer);
    console.log('✓ 洛雪生态 ZIP 已生成:', zipPath, '(共 ' + built.usableCount + ' 个可用脚本，独立名 ' + built.uniqueNames + ' 个)');
  }

  // 产出静态看板数据 public/data.json
  const dataJson = exporter.buildStaticDataJson(db, store);
  console.log('✓ 静态清单 data.json 已生成: 可用 ' + dataJson.usableCount + ' 个 | 平台分布:', JSON.stringify(dataJson.platformStats));

  store.saveNow();
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('=== 全流程完成，总耗时 ' + sec + 's ===');
  process.exit(0);
})();
