'use strict';
// 沙箱深检工人进程：隔离恶意/死循环脚本，防止污染主进程。
const sandbox = require('./sandbox');

process.on('unhandledRejection', function () { /* 吞掉未捕获 Promise 拒绝 */ });
process.on('uncaughtException', function (e) {
  process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: false, loadError: String(e && e.message || e).slice(0, 200), inited: false, platforms: {}, extractedCandidates: [] }));
  process.exit(2);
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (d) { buf += d; });
process.stdin.on('end', function () {
  let code = buf;
  let name = '';
  try {
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed.code === 'string') {
      code = parsed.code;
      name = parsed.name || '';
    }
  } catch (e) { /* 兼容纯文本传参 */ }

  sandbox.deepCheck(code, name).then(function (r) {
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
  }).catch(function (e) {
    process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: false, loadError: String(e && e.message || e).slice(0, 200), inited: false, platforms: {}, extractedCandidates: [] }));
    process.exit(0);
  });

  setTimeout(function () {
    process.stdout.write(JSON.stringify({ checkedAt: Date.now(), loadable: true, loadError: '平台测试超时', inited: true, platforms: {}, extractedCandidates: [] }));
    process.exit(3);
  }, 85000).unref();
});
