// ============================================================
// selfcheck.js — TikTok下载器 全局自检脚本
// 每次改完代码后运行：node selfcheck.js
// 检查：语法 / CSS 括号 / 功能链路 / 跨文件 token 一致 / 权限域名
// 全部通过才可交付。
// ============================================================
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const TOKEN = 'tdp2026x7kq9mz3vn8clw4r';
const API_BASE = 'https://tiktok-downloader-av8.pages.dev';

let pass = 0, fail = 0;
const ok = (msg) => { pass++; console.log('  ✅ ' + msg); };
const bad = (msg) => { fail++; console.log('  ❌ ' + msg); };

console.log('=== 1. 语法检查 ===');
const jsFiles = ['background.js', 'popup.js', 'content.js', 'common.js', 'web/index.html', 'web/_worker.js'];
for (const f of jsFiles) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { bad(f + ' 不存在'); continue; }
  try {
    if (f.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    } else if (f.endsWith('.html')) {
      const html = fs.readFileSync(p, 'utf8');
      const scripts = html.match(/<script[\s\S]*?<\/script>/g) || [];
      for (const sc of scripts) {
        const code = sc.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        if (!code.trim()) continue;
        fs.writeFileSync(path.join(ROOT, '_tmp_check.js'), code);
        try {
          execFileSync(process.execPath, ['--check', path.join(ROOT, '_tmp_check.js')], { stdio: 'pipe' });
        } finally { fs.unlinkSync(path.join(ROOT, '_tmp_check.js')); }
      }
    }
    ok(f + ' 语法通过');
  } catch (e) { bad(f + ' 语法错误: ' + (e.stderr || e.message).toString().split('\n')[0]); }
}

console.log('=== 2. JSON / CSS 结构 ===');
try {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok('manifest.json 合法, version=' + m.version);
  if (!m.version || !/^\d+\.\d+\.\d+$/.test(m.version)) bad('manifest 版本号格式异常');
  const css = fs.readFileSync(path.join(ROOT, 'popup.css'), 'utf8');
  const o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
  o === c ? ok('popup.css 括号平衡 (' + o + ')') : bad('popup.css 括号不平衡 ' + o + '/' + c);
  if (css.includes('backdrop-filter')) bad('popup.css 仍含 backdrop-filter（抖动隐患）');
  else ok('popup.css 无 backdrop-filter');
  if (!css.includes('scrollbar-gutter: stable')) bad('popup.css 缺 scrollbar-gutter（左右跳隐患）');
  else ok('popup.css scrollbar-gutter 存在');
  if (!css.includes('  height: 600px;')) bad('popup.css body 未固定 600px（Chrome popup 最大高度约 600，超过会被截断）');
  else ok('popup.css body 固定高度');
  if (!/^\.app \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/m.test(css)) bad('popup.css 缺全局 .app flex');
  else ok('popup.css 全局 .app flex');
} catch (e) { bad('manifest/css 检查异常: ' + e.message); }

console.log('=== 3. 功能链路（插件） ===');
{
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const checks = [
    ['parseViaOwnBackend 存在', bg.includes('parseViaOwnBackend')],
    ['OWN_PARSE_API 存在', bg.includes('OWN_PARSE_API')],
    ['OWN_PARSE_TOKEN 一致', bg.includes("OWN_PARSE_TOKEN = '" + TOKEN + "'") || bg.includes('OWN_PARSE_TOKEN = "' + TOKEN + '"')],
    ['OWN_PROXY_API 存在', bg.includes('OWN_PROXY_API')],
    ['下载链路（直连/代理）', bg.includes('直连逐个尝试') && bg.includes('代理逐个尝试')],
    ['原画质先取新签名', bg.includes('skipIntercept: true') && bg.includes('freshUrl')],
    ['直连白名单分流', bg.includes('isDirectFriendlyHost')],
    ['代理探测防坏成功', bg.includes('probeProxyCandidate')],
    ['去 HLS 候选', bg.includes('hlsCandidates')],
    ['多候选下载链', bg.includes('const candidates = []')],
    ['代理失败重试', bg.includes('await sleep(1200)')],
    ['卡死超时不杀大文件', bg.includes('checkTimeout')],
    ['单视频预算防堵队列', bg.includes('EFFORT_MS') && bg.includes('_gaveUp')],
    ['图集代理兜底', bg.includes('OWN_PROXY_API + encodeURIComponent(imageUrl)')],
    ['recommend-auto-parse 监听', bg.includes("type === 'recommend-auto-parse'")],
    ['download-single 监听', bg.includes("type === 'download-single'")],
    ['download-all-background 监听', bg.includes("type === 'download-all-background'")],
    ['两段式解析窗口（5s原画质/3s API）', bg.includes('PARSE_ORIG_MS') && bg.includes('PARSE_API_MS')],
    ['3 并发解析池', bg.includes('PARSE_POOL') && bg.includes('pumpUntilIdle')],
  ];
  for (const [name, v] of checks) v ? ok('background: ' + name) : bad('background: ' + name);
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const pchecks = [
    ['getAutoParseTarget 存在', popup.includes('function getAutoParseTarget')],
    ['setupAutoParse 定义', popup.includes('function setupAutoParse')],
    ['三种模式自动解析', (popup.match(/setupAutoParse\(\{/g) || []).length === 3],
    ['handleParse 存在', popup.includes('function handleParse')],
    ['空态模板一致', popup.includes('empty-title')],
    ['themeToggle 绑定', popup.includes('themeToggle')],
  ];
  for (const [name, v] of pchecks) v ? ok('popup: ' + name) : bad('popup: ' + name);
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const cchecks = [
    ['getCurrentVideoInfo 已定义', content.includes('function getCurrentVideoInfo')],
    ['isAutoParsePage 已定义', content.includes('function isAutoParsePage')],
    ['搜索页匹配', content.includes("path.startsWith('/search')")],
    ['recommend-auto-parse 发送', content.includes("type: 'recommend-auto-parse'")],
  ];
  for (const [name, v] of cchecks) v ? ok('content: ' + name) : bad('content: ' + name);
}

console.log('=== 4. 功能链路（网页版 / 后端） ===');
{
  const w = fs.readFileSync(path.join(ROOT, 'web/_worker.js'), 'utf8');
  const wchecks = [
    ['/api/parse 存在', w.includes('/api/parse')],
    ['/api/proxy 存在', w.includes('/api/proxy')],
    ['/api/diag-page 存在', w.includes('/api/diag-page')],
    ['TOKEN 一致', w.includes("const TOKEN = '" + TOKEN + "'")],
    ['UA 轮询（PROXY_UAS）', w.includes('PROXY_UAS')],
    ['CORS 头', w.includes('Access-Control-Allow-Origin')],
    ['CDN 白名单', w.includes('tiktokcdn-eu.com') && w.includes('webapp-prime.tiktok.com')],
    ['代理 403 重试 cookie', w.includes('cookieCache = { value: \'\', at: 0 }')],
  ];
  for (const [name, v] of wchecks) v ? ok('_worker: ' + name) : bad('_worker: ' + name);
  const idx = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const ichecks = [
    ['自建后端接入', idx.includes('parseViaOwnBackend')],
    ['OWN_PARSE_API 指向（绝对或同域相对）', idx.includes('/api/parse')],
    ['token 一致', idx.includes(TOKEN)],
    ['图集下载', idx.includes('albumUrls')],
  ];
  for (const [name, v] of ichecks) v ? ok('index.html: ' + name) : bad('index.html: ' + name);
}

console.log('=== 5. 权限与域名 ===');
{
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const perms = m.permissions || [];
  const hosts = m.host_permissions || [];
  const needPerms = ['downloads', 'storage', 'tabs', 'scripting', 'sidePanel', 'webRequest'];
  for (const p of needPerms) perms.includes(p) ? ok('权限: ' + p) : bad('缺权限: ' + p);
  hosts.some(h => h.includes('tiktok-downloader-av8.pages.dev')) ? ok('host: pages.dev') : bad('host 缺 pages.dev（自建后端）');
  hosts.some(h => h.includes('tiktok.com')) ? ok('host: tiktok.com') : bad('host 缺 tiktok.com');
  const hasCS = (m.content_scripts || []).some(c => (c.matches || []).some(x => x.includes('tiktok.com')));
  hasCS ? ok('content_scripts 注入 tiktok.com') : bad('content_scripts 未注入 tiktok.com');
}

console.log('=== 6. git 状态 ===');
try {
  const st = execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).trim();
  st ? console.log('  未提交文件:\n' + st.split('\n').map(l => '    ' + l).join('\n')) : ok('工作区干净');
} catch (e) { bad('git status 失败'); }

console.log('=== 7. 自动解析模拟测试（真实执行 popup.js） ===');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'autoparse_test.js')], { encoding: 'utf8' });
  const last = out.trim().split('\n').slice(-1)[0];
  if (last.includes('0 失败')) ok('autoparse_test: ' + last);
  else bad('autoparse_test 未全过: ' + last);
} catch (e) {
  bad('autoparse_test 运行失败: ' + (e.stdout || e.message || '').toString().split('\n').slice(-2).join(' '));
}

console.log('\n========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail > 0 ? 1 : 0);
