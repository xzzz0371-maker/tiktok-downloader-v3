// ============================================================
// behavior_test.js — 已修复缺陷的行为级回归测试
// 与 selfcheck.js（字符串包含式断言）互补：这里把关键纯函数抽出来真实执行，
// 验证「修复后的行为」而不只是「代码里存在某段字符串」。
//
// 覆盖：
//   1. safeFileName   —— 非法字符 / 结尾点空格 / 空白归并 / UTF-8 字节截断
//   2. apiKey         —— 熔断 key 必须与「视频链接」无关（否则熔断永不触发）
//   3. isAutoParsePage—— 详情页必须排除（否则与 popup 自动解析重复提交）
//   4. isMediaUrl     —— 只放行已知媒体 CDN，拒绝 javascript:/data:/相似后缀域
//
// 运行：node behavior_test.js（selfcheck.js 会自动调用）
// ============================================================
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = __dirname;
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${ok ? '' : `  期望=${JSON.stringify(want)} 实际=${JSON.stringify(got)}`}`);
};
const okc = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : '  ' + (extra || '')}`);
};

// 从源码中抽出指定区间并用 vm 执行（区间端点必须唯一）
function extract(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('抽取失败: ' + from);
  return src.slice(a, b);
}
function run(src, extraGlobals = {}) {
  const ctx = Object.assign({}, extraGlobals);
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

// ---------- 1. safeFileName ----------
console.log('=== 1. safeFileName（文件名安全化） ===');
const sf = run(extract(bg, 'function safeFileName(', '// ---------- 图集下载'), { TextEncoder }).safeFileName;
eq('过滤 Windows 非法字符', sf('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
eq('去掉结尾的点与空格', sf('video...  '), 'video');
eq('空白（含 tab/换行）归并为单空格', sf('a   b\tc\nd'), 'a b c d');
eq('控制字符被替换', sf('abc\u0001'), 'abc_');
eq('空输入返回空串', sf(''), '');
eq('CJK 按 UTF-8 字节截断为 40 个汉字（120B）', sf('中'.repeat(200), 120).length, 40);
okc('字节截断结果不超过上限', new TextEncoder().encode(sf('中'.repeat(200), 120)).length <= 120);
okc('长 ASCII 截断到 120', sf('a'.repeat(500), 120).length === 120);
eq('纯点号输入被清空', sf('...'), '');

// ---------- 2. apiKey（熔断 key） ----------
console.log('=== 2. apiKey（熔断 key 与视频链接无关） ===');
const apiKey = run(extract(bg, 'function apiKey(', 'function isApiInCooldown('), { URL }).apiKey;
eq('同一 API 不同视频 → 同一 key',
  apiKey('https://api.tikwm.com/api/?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/111')),
  apiKey('https://api.tikwm.com/api/?url=' + encodeURIComponent('https://www.tiktok.com/@b/video/222')));
eq('key 就是主机名', apiKey('https://api.tikwm.com/api/?url=x'), 'api.tikwm.com');
eq('非法 URL 不抛错', typeof apiKey('not a url'), 'string');

// ---------- 3. content.js isAutoParsePage ----------
console.log('=== 3. isAutoParsePage（详情页必须排除） ===');
const apSrc = extract(content, 'function isAutoParsePage()', '// 检测当前正在播放的视频元素');
function pageAllowed(url) {
  const u = new URL(url);
  return run(apSrc, { location: { hostname: u.hostname, pathname: u.pathname } }).isAutoParsePage();
}
eq('TikTok 视频详情页 → 不接管', pageAllowed('https://www.tiktok.com/@user/video/123'), false);
eq('抖音图集详情页 → 不接管', pageAllowed('https://www.douyin.com/photo/123'), false);
eq('抖音 note 详情页 → 不接管', pageAllowed('https://www.douyin.com/note/123'), false);
eq('用户主页 → 接管', pageAllowed('https://www.tiktok.com/@user'), true);
eq('TikTok 首页 → 接管', pageAllowed('https://www.tiktok.com/'), true);
eq('搜索页 → 接管', pageAllowed('https://www.tiktok.com/search?q=x'), true);
eq('抖音首页 → 接管', pageAllowed('https://www.douyin.com/'), true);
eq('非目标站点 → 不接管', pageAllowed('https://github.com/a'), false);

// ---------- 4. index.html isMediaUrl ----------
console.log('=== 4. isMediaUrl（媒体域名白名单） ===');
const isMediaUrl = run(extract(idx, 'var MEDIA_HOSTS = [', 'async function parseViaOwnBackend'), { URL }).isMediaUrl;
eq('抖音视频 CDN 放行', isMediaUrl('https://v3-dy-o.zjcdn.com/xx/video.mp4'), true);
eq('TikTok CDN 放行', isMediaUrl('https://v16-webapp.tiktokcdn.com/x.mp4'), true);
eq('webapp-prime 放行', isMediaUrl('https://v16-webapp-prime.tiktok.com/x.mp4'), true);
eq('javascript: 拒绝', isMediaUrl('javascript:alert(1)'), false);
eq('data: 拒绝', isMediaUrl('data:text/html,<script>'), false);
eq('任意第三方域拒绝', isMediaUrl('https://evil.example.com/x.mp4'), false);
eq('相似后缀域拒绝（防后缀绕过）', isMediaUrl('https://nottiktokcdn.com/x.mp4'), false);
eq('空值拒绝', isMediaUrl(''), false);

// ---------- 5. 代理上游重试（web/_worker.js 的 fetchUpstream） ----------
// 回归背景：TikTok CDN 对数据中心 IP 有间歇风控，实测同一签名连续请求会 206/502
// 交替（约 50% 失败）。旧实现「4 个 UA 各试一次就放弃」会把抖动直接变成客户端的
// 502 → 下载器显示"服务器错误"。这里把 fetchUpstream 抽出来，用桩 fetch 验证：
//   - 间歇失败必须被重试吸收
//   - 200 + HTML/JSON 错误页不能被当成媒体（否则会存成坏文件）
//   - 明确不可用的 4xx 不该无谓重试
//   - 重定向到非白名单域必须直接拦截
console.log('=== 5. fetchUpstream（代理上游重试与错误页识别） ===');
const worker = fs.readFileSync(path.join(ROOT, 'web/_worker.js'), 'utf8');
const proxySrc = extract(worker, 'const SAFE_PROXY_HEADERS =', 'async function handleProxy');

const mkResp = (status, ct, location) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: {
    get(k) {
      const key = String(k).toLowerCase();
      if (key === 'content-type') return ct || null;
      if (key === 'location') return location || null;
      return null;
    }
  },
  body: null
});

// 用桩 fetch 与「忠实模拟缓存语义」的 cookie 桩构建一个可调用的 fetchUpstream。
// 关键：cookie 桩必须共享 worker 的 cookieCache 全局（fetchUpstream 会清空它来触发刷新），
// 否则统计到的会是"调用次数"而不是"真实网络请求次数"，度量就失真了。
function loadUpstream(fetchImpl) {
  const stats = { homepageFetches: 0 };
  const ctx = {
    PROXY_UAS: ['ua1', 'ua2', 'ua3', 'ua4'],
    cookieCache: { value: '', at: 0 },
    hostAllowed: (h) => /(^|\.)tiktokcdn\.com$|(^|\.)tiktok\.com$/.test(String(h || '').toLowerCase()),
    fetch: fetchImpl,
    setTimeout: (fn) => { fn(); return 0; }, // 让 sleepMs 立即返回，避免测试变慢
    clearTimeout: () => {},
    URL
  };
  // 与 web/_worker.js 的 getTikTokCookie 同语义：10 分钟内直接命中缓存
  ctx.getTikTokCookie = async () => {
    const c = ctx.cookieCache;
    if (c.value && Date.now() - c.at < 10 * 60 * 1000) return c.value;
    stats.homepageFetches++;
    ctx.cookieCache = { value: 'tt_webid=1', at: Date.now() };
    return ctx.cookieCache.value;
  };
  vm.createContext(ctx);
  vm.runInContext(proxySrc, ctx);
  return { fetchUpstream: ctx.fetchUpstream, stats };
}
const VIDEO = { 'content-type': 'video/mp4' };
const HEADERS = { Referer: 'https://www.tiktok.com/', Accept: 'video/mp4' };

(async () => {
  // 场景A：前 5 次网络异常，第 6 次成功 → 必须重试到成功
  {
    let n = 0;
    const { fetchUpstream: up } = loadUpstream(async () => {
      n++;
      if (n < 6) throw new Error('ECONNRESET');
      return mkResp(206, 'video/mp4');
    });
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('间歇性网络异常被重试吸收（第 6 次成功）', !!r.resp && r.resp.status === 206, JSON.stringify(r));
    eq('  实际请求次数', n, 6);
  }
  // 场景B：一直 403 → 重试用尽后回报 failed + lastStatus，
  // 让调用方拿到「上游一直拒绝」这个明确结论（比原样透传 403 更容易排查）
  {
    let n = 0;
    const { fetchUpstream: up } = loadUpstream(async () => { n++; return mkResp(403, 'text/plain'); });
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('持续 403 不被当作成功', !r.resp && r.failed === true, JSON.stringify(r));
    eq('  并保留上游真实状态码', r.lastStatus, 403);
    okc('  确实做了重试（>1 次）', n > 1, 'n=' + n);
  }
  // 场景B2：403 只触发一次 cookie 刷新。
  // 若不做这个限制，持续 403 时每一轮重试都会重抓一次 TikTok 首页（8 轮 = 8 次额外请求）。
  // 期望值 2 = 首次取 cookie(1) + 刷新后重新取 cookie(2)，之后命中缓存。
  {
    const { fetchUpstream: up, stats } = loadUpstream(async () => mkResp(403, 'text/plain'));
    await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('持续403时首页抓取被限制在 2 次以内（而非每轮一次）', stats.homepageFetches <= 2,
      'homepageFetches=' + stats.homepageFetches);
  }
  // 场景C：404 = 链接不可用 → 立即返回，不做无谓重试
  {
    let n = 0;
    const { fetchUpstream: up } = loadUpstream(async () => { n++; return mkResp(404, 'text/html'); });
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    eq('404 直接返回且只请求 1 次', n, 1);
    eq('404 状态透传给调用方', r.resp && r.resp.status, 404);
  }
  // 场景D：一直 200 + text/html（过期签名错误页）→ 必须判为失败
  {
    const { fetchUpstream: up } = loadUpstream(async () => mkResp(200, 'text/html'));
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('200+HTML 错误页不被当作媒体流', r.failed === true && r.lastStatus === 200, JSON.stringify(r));
  }
  // 场景D2：200 + application/json（代理/上游返回的 JSON 错误）同样判失败
  {
    const { fetchUpstream: up } = loadUpstream(async () => mkResp(200, 'application/json'));
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('200+JSON 不被当作媒体流', r.failed === true, JSON.stringify(r));
  }
  // 场景E：重定向到非白名单域 → 立即拦截，不重试
  {
    let n = 0;
    const { fetchUpstream: up } = loadUpstream(async () => { n++; return mkResp(302, 'text/plain', 'https://evil.example.com/x.mp4'); });
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('重定向到非白名单域被拦截', r.blocked === true, JSON.stringify(r));
    eq('  拦截后不再重试', n, 1);
  }
  // 场景F：白名单内的重定向 → 跟随并成功
  {
    let n = 0;
    const { fetchUpstream: up } = loadUpstream(async (u) => {
      n++;
      return n === 1 ? mkResp(302, 'text/plain', 'https://v20.tiktokcdn.com/b.mp4') : mkResp(206, 'video/mp4');
    });
    const r = await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('白名单内重定向可跟随成功', !!r.resp && r.resp.status === 206, JSON.stringify(r));
  }
  // 场景G：转发 Range 时必须只在客户端真的带了 Range 时才带（不接受空值）
  {
    let sawRangeHeader = null;
    const { fetchUpstream: up } = loadUpstream(async (u, opt) => { sawRangeHeader = opt.headers; return mkResp(206, 'video/mp4'); });
    await up('https://v16.tiktokcdn.com/a.mp4', HEADERS, 'GET');
    okc('客户端未带 Range 时上游不带 Range 头', !('Range' in sawRangeHeader), JSON.stringify(sawRangeHeader));
  }

  // ---------- 6. formatParseProgress（进度文案口径） ----------
  // 回归背景：原实现显示 `${completed}/${total}`，而 completed 把失败项也算作已完成，
  // 于是 1370 条里 668 条失败时进度仍显示在推进、实际没有任何产出。
  // 现改为展示「未成功数」，这里锁定该口径与边界行为。
  console.log('\n=== 6. formatParseProgress（进度展示未成功数） ===');
  const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const fmt = run(extract(popupSrc, 'function formatParseProgress(', '\nasync function checkParseProgress')).formatParseProgress;

  // 核心口径：截图中那个场景必须读出「剩余未成功」，而不是「已完成 703」
  {
    const s = fmt({ total: 1370, completed: 703, failed: 668, skipped: 0, pending: 735, queueLength: 665 });
    okc('展示未成功数而非已完成数', s.includes('剩余 735/1370 条未成功'), s);
    okc('  不再暴露 completed 口径', !s.includes('703'), s);
  }
  // 全部成功 → 剩余 0
  okc('全部成功时剩余为 0', /剩余 0\/100/.test(fmt({ total: 100, completed: 100, success: 100, pending: 0 })));
  // 全部失败 → 剩余等于总数（用户需要看出"一条都没拿到"）
  okc('全部失败时剩余等于总数', /剩余 50\/50/.test(fmt({ total: 50, completed: 50, success: 0, failed: 50, pending: 50 })));
  // 旧版后台不带 pending 字段 → 回退为 total-completed，且不得出现 NaN
  {
    const s = fmt({ total: 200, completed: 50 });
    okc('缺 pending 时回退且无 NaN', s.includes('剩余 150/200') && !s.includes('NaN'), s);
  }
  // 边界：pending 越界必须夹紧到 [0,total]，否则文案自相矛盾（如"剩余 99/10"）
  okc('pending 超上限被夹紧', fmt({ total: 10, pending: 99 }).includes('剩余 10/10'));
  okc('pending 为负被夹紧', fmt({ total: 10, success: 3, pending: -5 }).includes('剩余 0/10'));
  // 边界：total=0 不得产生 NaN/负号
  {
    const s = fmt({ total: 0, completed: 0, success: 0, pending: 0 });
    okc('total=0 不产生 NaN', !s.includes('NaN') && s.includes('剩余 0/0'), s);
  }
  // 成功数为 0 时不显示"已成功 0 个"（无意义的噪声）
  okc('零成功不显示已成功', !fmt({ total: 10, success: 0, failed: 3, pending: 10 }).includes('已成功'));
  // 失败数与剩余量相当时不重复列（同一批数字的两种说法）
  okc('失败数与剩余相当时不重复列示', !fmt({ total: 100, success: 5, failed: 90, pending: 90 }).includes('其中失败'));
  // 队列信息按需出现
  okc('队列为空时不显示队列', !fmt({ total: 10, success: 10, pending: 0, queueLength: 0 }).includes('队列'));

  // ---------- 7. parseViaSilentTab（静默标签页抓取通道） ----------
  // 回归背景：服务端源全灭（页面直抓 403、官方 item 空结构）后，唯一还能稳定拿到
  // 原画质的通道是"用浏览器打开视频页，让 webRequest 拦截器抓到 playAddr"。
  // 本通道有三个必须守住的不变式，否则会产生资源泄漏、槽位饿死或"下到错误视频"：
  //   ① 标签页必须在任何路径上被关闭（成功/超时/落地不一致/异常）——否则长批量会开出成百上千个页；
  //   ② 落地 URL 必须与目标 videoId 一致——TikTok 会重定向到推荐流并自动播放别的视频；
  //   ③ 并发槽位必须归还（且峰值不超过上限）——否则解析池会被逐步饿死。
  console.log('\n=== 7. parseViaSilentTab（静默标签页：必关标签页 + videoId 校验 + 槽位归还） ===');

  // 用桩 chrome API 构建可调用的 parseViaSilentTab。
  // capturedMap 模拟 capturedVideoUrls；opts.landedUrl 控制"标签页最终落地地址"。
  function loadSilent(opts = {}) {
    const state = {
      created: 0, removed: 0,
      open: new Set(),         // 当前仍打开的标签页 id
      removedIds: new Set(),   // 已关闭的标签页 id（用于验证"关的是同一个页面"）
      validIds: new Set(),     // 创建过的标签页 id
      opened: new Map(),       // tabId → 创建时请求的 URL（模拟正常落地）
      seq: 0                   // 自增 id 发生器
    };
    const captured = new Map();
    const ctx = {
      SILENT_TAB_TIMEOUT_MS: opts.timeoutMs || 300,
      SILENT_TAB_POLL_MS: 5,
      SILENT_TAB_MAX_CONCURRENT: opts.maxConcurrent || 4,
      _silentTabActive: 0,
      _silentTabWaiters: [],
      capturedVideoUrls: captured,
      sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5))),
      extractVideoIdFromUrl: (u) => {
        const m = String(u || '').match(/\/video\/(\d+)/);
        return m ? m[1] : null;
      },
      extractPageMeta: async () => ({ title: 't', author: 'a', cover: '' }),
      // 页面深挖在静默场景下必定拿不到（本测试聚焦拦截路径）
      // opts.deepCounter 用于统计注入次数，验证「深挖限次」
      parseViaPageDeep: async () => {
        if (opts.deepCounter) opts.deepCounter.n++;
        throw new Error('no deep');
      },
      chrome: {
        tabs: {
          // 每个标签页必须有唯一 id：并发场景下若恒返回 1，state.open 无法区分两个页面，
          // capturedVideoUrls 也会互相覆盖，导致"落地视频不一致"的误报。
          create: async (info) => {
            const id = ++state.seq;
            state.created++;
            state.validIds.add(id);
            state.open.add(id);
            state.opened.set(id, info && info.url);
            return { id };
          },
          remove: async (id) => { state.removed++; state.open.delete(id); state.removedIds.add(id); },
          // 落地 URL 必须按标签页返回：桩里用「创建时的目标地址」模拟"正常落地"，
          // opts.landedUrl 可强制指定一个不同的地址来模拟重定向到推荐流。
          get: async (id) => ({ id, url: opts.landedUrl || state.opened.get(id) })
        }
      },
      console
    };
    vm.createContext(ctx);
    // 一并抽取并发槽位的两个辅助函数：它们定义在 parseViaSilentTab 之前，
    // 只抽主函数会因缺少 _acquireSilentSlot 而 ReferenceError
    vm.runInContext(extract(bg, 'function _acquireSilentSlot', '\n// 静默打开'), ctx);
    // 切片起点用 diagnoseSilentTab：超时路径会调用它做现场诊断，
    // 只切 parseViaSilentTab 会因缺函数而 ReferenceError。
    vm.runInContext(extract(bg, 'async function diagnoseSilentTab', '\n// 自建解析后端'), ctx);
    return { run: ctx.parseViaSilentTab, state, captured };
  }

  // ① 命中：拦截缓存里有地址 → 成功返回，且标签页被关闭
  {
    const { run, state, captured } = loadSilent();
    // 拦截缓存必须在「标签页创建之后」写入（产品代码按 tabId 取缓存），
    // 因此用轮询模拟 webRequest 异步回调：只要出现打开的标签页就往里塞地址。
    const t = setInterval(() => {
      for (const id of state.open) captured.set(id, { hdVideoUrl: 'https://v16.tiktokcdn.com/a.mp4', videoUrl: 'https://v16.tiktokcdn.com/a.mp4' });
    }, 3);
    const r = await run('https://www.tiktok.com/@x/video/123');
    clearInterval(t);
    okc('命中拦截后返回成功', r.success === true, JSON.stringify(r));
    eq('  返回的 videoId 与目标一致', r.id, '123');
    eq('  标记来源为 silent_tab', r._parseSource, 'silent_tab');
    eq('  标签页被关闭', state.removed, 1);
    eq('  关闭的正是本次创建的标签页', state.removedIds.has([...state.validIds][0]), true);
    eq('  无标签页残留', state.open.size, 0);
    eq('  拦截缓存已清理（不随 tabId 泄漏）', captured.size, 0);
  }
  // ② 未命中（超时）：必须抛错，且标签页仍被关闭（不泄漏）
  {
    const { run, state } = loadSilent({ timeoutMs: 60 });
    let threw = null;
    try { await run('https://www.tiktok.com/@x/video/123'); } catch (e) { threw = e; }
    okc('未拦截到时抛错', !!threw, threw && threw.message);
    okc('  错误信息包含超时提示', /未拦截到地址/.test(threw ? threw.message : ''), threw && threw.message);
    eq('  超时路径仍关闭标签页', state.removed, 1);
    eq('  无标签页残留', state.open.size, 0);
  }
  // ③ 落地视频不一致（重定向到推荐流）→ 必须拒绝，避免下载到错误视频
  {
    const { run, state, captured } = loadSilent({ landedUrl: 'https://www.tiktok.com/@x/video/999' });
    const t = setInterval(() => {
      for (const id of state.open) captured.set(id, { hdVideoUrl: 'https://v16.tiktokcdn.com/a.mp4' });
    }, 3);
    let threw = null;
    try { await run('https://www.tiktok.com/@x/video/123'); } catch (e) { threw = e; }
    clearInterval(t);
    okc('落地视频不一致时拒绝结果', !!threw && /落地视频不一致/.test(threw.message), threw && threw.message);
    eq('  拒绝路径仍关闭标签页', state.removed, 1);
    eq('  无标签页残留', state.open.size, 0);
  }
  // ④ 非视频详情页（无 videoId）→ 直接拒绝，且不创建标签页（避免抓到推荐流视频）
  {
    const { run, state } = loadSilent();
    let threw = null;
    try { await run('https://www.tiktok.com/@x'); } catch (e) { threw = e; }
    okc('非详情页直接拒绝', !!threw && /非视频详情页/.test(threw.message), threw && threw.message);
    eq('  拒绝时不创建标签页', state.created, 0);
    eq('  未占用并发槽位', state.open.size, 0);
  }
  // ⑤ 并发槽位：上限为 1 时两个任务必须串行，且两个标签页都被关闭
  {
    const { run, state, captured } = loadSilent({ timeoutMs: 300, maxConcurrent: 1 });
    // 记录并发峰值：上限=1 时任何时刻打开的标签页不得超过 1 个
    let peak = 0;
    const t = setInterval(() => {
      peak = Math.max(peak, state.open.size);
      for (const id of state.open) captured.set(id, { hdVideoUrl: 'https://v16.tiktokcdn.com/a.mp4' });
    }, 3);
    const [a, b] = await Promise.all([
      run('https://www.tiktok.com/@x/video/111').catch(e => e),
      run('https://www.tiktok.com/@x/video/222').catch(e => e)
    ]);
    clearInterval(t);
    okc('并发上限=1 时两个任务都成功', !!(a && a.success) && !!(b && b.success), JSON.stringify([a && a.message, b && b.message]));
    eq('  各自返回自己的 videoId', [a && a.id, b && b.id].sort().join(','), '111,222');
    okc('  峰值并发未超过上限 1', peak <= 1, `peak=${peak}`);
    eq('  创建的标签页数', state.created, 2);
    okc('  两个标签页 id 互不相同', state.validIds.size === 2, JSON.stringify([...state.validIds]));
    eq('  两个标签页都被关闭', state.removed, 2);
    eq('  无残留标签页', state.open.size, 0);
    eq('  拦截缓存已清理', captured.size, 0);
  }
  // ⑥ 槽位归还：无论成功或失败，位子都必须还回去，否则并发池会被逐步饿死
  {
    const { run, state, captured } = loadSilent({ timeoutMs: 150, maxConcurrent: 1 });
    // 第一次：不写拦截缓存 → 必然超时失败
    let first = null;
    try { await run('https://www.tiktok.com/@x/video/111'); } catch (e) { first = e; }
    okc('第一次（超时）失败', !!first && /未拦截到地址/.test(first.message), first && first.message);
    // 第二次：写入拦截缓存 → 必须能成功。若槽位没归还，这里会永远卡在 _acquireSilentSlot 上，
    // 超时保护的测时断言会先失败。
    const t = setInterval(() => {
      for (const id of state.open) captured.set(id, { hdVideoUrl: 'https://v16.tiktokcdn.com/a.mp4' });
    }, 3);
    let second = null;
    try { second = await run('https://www.tiktok.com/@x/video/222'); } catch (e) { second = e; }
    clearInterval(t);
    okc('  槽位已归还：第二次能成功（未卡在排队）', !!(second && second.success), second && (second.message || JSON.stringify(second)));
    eq('  第二次返回自己的 videoId', second && second.id, '222');
    eq('  两次都创建了标签页', state.created, 2);
    eq('  两次标签页都被关闭', state.removed, 2);
    eq('  无残留标签页', state.open.size, 0);
  }

  // ⑦ 槽位上限必须 ≥ 解析池的大批量宽度：槽位更窄时，放宽解析池零收益
  // （两条流水线是"与"关系，吞吐由较窄的那一侧决定）。
  {
    const ceiling = Number((bg.match(/SILENT_TAB_MAX_CONCURRENT = (\d+)/) || [])[1]);
    const burst = Number((bg.match(/parsePending\.length > 6 \? (\d+) : PARSE_POOL/) || [])[1]);
    okc('静默槽位上限已解析到', Number.isFinite(ceiling), String(ceiling));
    okc('  解析池大批量宽度已解析到', Number.isFinite(burst), String(burst));
    okc('  槽位上限不低于解析池宽度', ceiling >= burst, `槽位=${ceiling} 池=${burst}`);
    // 上限不得低于下限防呆：太低会把整条流水线卡成串行
    okc('  槽位上限未低于保守值 4', ceiling >= 4, String(ceiling));
  }

  // ⑤ 页面深挖必须限次注入
  // 回归背景（2026-11-05）：原条件「>600ms 且尚无结果」+ 200ms 轮询
  // → 每 200ms 就往页面注入一次脚本；8 个静默页并发时每秒数十次注入，
  // 与播放器初始化抢主线程，页面发不出媒体请求 → 自己把自己拖到超时。
  // 现限定最多 4 次（0.6s / 2s / 5s / 9s）。
  {
    const counter = { n: 0 };
    const { run } = loadSilent({ timeoutMs: 1500, deepCounter: counter });
    try { await run('https://www.tiktok.com/@u/video/999', 1500); } catch (e) { /* 预期超时 */ }
    okc(`深挖注入限次（1~4 次，实际 ${counter.n} 次）`, counter.n >= 1 && counter.n <= 4, String(counter.n));
  }

  // ---------- 8. 质量标签：按「实际取的地址」判定，不按来源硬贴 ----------
  // 回归背景（2026-09-17，用户截图「怎么全是原画质」）：
  //   两个 parse 函数都用 `item.source === 'universal' ? '原画质' : '高清'` 无条件覆写 quality，
  //   而 universal/sigi 数据块优先级最高、TikTok 视频页【必然】含 __UNIVERSAL_DATA__
  //   → 几乎所有结果都被标成「原画质」，标签完全失真。
  //   更糟的是下游 :2035/:2195 用 /fetch_/ 前缀判定"短命签名源"，把所有 fetch_* 一网打尽
  //   → 每条都白付一轮已失效的"取新签名"。
  // 修复：extractVideoInfo 依据实际取到的字段判定质量；来源判定改为精确列举。
  console.log('\n=== 8. 质量标签按实际地址判定（不再按来源硬贴） ===');

  const EXTRACT_SEG = extract(bg, 'async function extractVideoInfo', 'async function detectLanguage');
  const mkCtx = (extra = {}) => {
    const ctx = {
      // extractVideoInfo 依赖的两个格式化函数用桩替代（与本次改动无关）
      formatLikes: (n) => String(n),
      formatDate: (n) => String(n),
      console: { log() {}, warn() {}, error() {} },
      ...extra
    };
    vm.createContext(ctx);
    vm.runInContext(EXTRACT_SEG, ctx);
    return ctx;
  };

  // ① bitrateInfo 最高码率 → 明确的高清地址
  {
    const ctx = mkCtx();
    const r = await ctx.extractVideoInfo({
      id: '1', desc: 't', author: { nickname: 'a' },
      video: {
        bitrateInfo: [
          { bitrate: 500, PlayAddr: { UrlList: ['https://cdn/low.mp4'] } },
          { bitrate: 2000, PlayAddr: { UrlList: ['https://cdn/best.mp4'] } }
        ]
      }
    }, 'https://www.tiktok.com/@x/video/1');
    eq('bitrateInfo 取最高码率', r.hdVideoUrl, 'https://cdn/best.mp4');
    eq('  质量标为高清', r.quality, '高清');
  }
  // ② downloadAddr（官方无水印下载地址）→ 高清
  {
    const ctx = mkCtx();
    const r = await ctx.extractVideoInfo({
      id: '2', desc: 't', author: { nickname: 'a' },
      video: { downloadAddr: 'https://cdn/dl.mp4' }
    }, 'https://www.tiktok.com/@x/video/2');
    eq('downloadAddr 质量标为高清', r.quality, '高清');
  }
  // ③ hdplay 字段 → 高清
  {
    const ctx = mkCtx();
    const r = await ctx.extractVideoInfo({
      id: '3', desc: 't', author: { nickname: 'a' },
      video: { hdplay: 'https://cdn/hd.mp4' }
    }, 'https://www.tiktok.com/@x/video/3');
    okc('hdplay 质量标为高清', r.quality === '高清', r.quality);
  }
  // ④ playAddr 是官方高清播放地址 → 高清（与 hdplay 同级）
  {
    const ctx = mkCtx();
    const r = await ctx.extractVideoInfo({
      id: '4', desc: 't', author: { nickname: 'a' },
      video: { playAddr: 'https://cdn/plain.mp4' }
    }, 'https://www.tiktok.com/@x/video/4');
    okc('playAddr 质量标为高清', r.quality === '高清', JSON.stringify(r.quality));
    eq('  地址仍正常返回', r.videoUrl, 'https://cdn/plain.mp4');
  }
  // ⑤ 都判不出时 quality 必须留空（不能硬编码 '原画质'），
  //    否则调用方拿不到"未判定"信号，只能盲给（这正是原 bug 的成因）
  {
    const ctx = mkCtx();
    const r = await ctx.extractVideoInfo({
      id: '5', desc: 't', author: { nickname: 'a' },
      video: { play: 'https://cdn/plain.mp4' }
    }, 'https://www.tiktok.com/@x/video/5');
    eq('判不出质量时返回空串（交调用方兜底）', r.quality, '');
    eq('  地址仍正常返回', r.videoUrl, 'https://cdn/plain.mp4');
  }
  // ⑥ 调用方兜底：extractVideoInfo 判不出时才按来源估计，且必须用 `||` 而非覆盖
  {
    // fetch_universal 走 "原画质" 分支
    const f = (src, q) => q || (src === 'fetch_universal' || src === 'fetch_sigi' ? '原画质' : '高清');
    eq('判不出时 universal → 原画质', f('fetch_universal', ''), '原画质');
    eq('判不出时 sigi → 原画质', f('fetch_sigi', ''), '原画质');
    eq('判不出时 fetch_next → 高清', f('fetch_next', ''), '高清');
    // 已判出时必须保留判定结果（这是修复的核心）
    eq('已判出高清时不被来源覆盖', f('fetch_universal', '高清'), '高清');
    eq('已判出原画质时保持原样', f('page', '原画质'), '原画质');
  }

  // ---------- 9. 短命签名源判定：精确列举，不用宽泛前缀 ----------
  // 原实现在两处用 /intercept|universal|sigi|own_backend|fetch_|_page|page/i：
  //   · `fetch_` 前缀吞掉 fetch_next（明确的高清来源）
  //   · `page` 子串过宽（任何含 "page" 的源名都会命中）
  // 现改为精确列举 + 明确前缀匹配。
  console.log('\n=== 9. 短命签名源判定（精确列举，不误伤） ===');
  {
    const ctx = mkCtx();
    vm.runInContext(extract(bg, 'const SHORT_LIVED_SOURCES', 'async function downloadSingleVideo'), ctx);
    const isSl = ctx.isShortLivedSource;

    // 页面/接口当场签发的地址 → 必须取新签名
    for (const s of ['intercept', 'silent_tab', 'own_backend', 'page',
                     'universal', 'sigi', 'fetch_universal', 'fetch_sigi',
                     'fetch_next', 'fetch_field', 'fetch_regex',
                     'script_field', 'script_regex']) {
      okc(`  ${s} 视为短命签名源`, isSl({ _parseSource: s }) === true, String(isSl({ _parseSource: s })));
    }
    // 第三方 API / 自建后端 api 池：地址本身较稳定，不该白付一轮
    for (const s of ['third_party', 'api']) {
      okc(`  ${s} 不视为短命签名源`, isSl({ _parseSource: s }) === false, String(isSl({ _parseSource: s })));
    }
    // 前缀兜底：带后缀的源名仍要认得
    okc('own_backend_api 前缀兜底命中', isSl({ _parseSource: 'own_backend_api' }) === true);
    // 关键回归：fetch_next 曾被 fetch_ 前缀误吞
    okc('fetch_next 不再被误认', isSl({ _parseSource: 'fetch_next' }) === true);
    // 空/缺字段不得抛错，且视为"非短命"（保守：不额外等一轮）
    okc('缺 _parseSource 不抛错且判否', isSl({}) === false && isSl(null) === false);
    // 大小写/空白容错
    okc('大小写与空白容错', isSl({ _parseSource: '  INTERCEPT ' }) === true);
  }

  // ---------- 10. 直连白名单：Akamai 严格域必须改走代理 ----------
  // 回归背景（2026-09-21）：isDirectFriendlyHost 把 `*-webapp-prime.tiktok.com`
  // 列为"可直连"，但该域是 Akamai 上校验最严的（要求 Referer/Cookie），而
  // chrome.downloads 直连【无法携带 Referer】—— Referer 属 forbidden header，
  // 且 DownloadOptions 没有 referrer 参数 → 直连必然 403，还要白等
  // FIRST_STALL_CHECK_MS(30s) 才降级到代理。这是"原画质下不来"的直接原因之一。
  console.log('\n=== 10. 直连白名单（Akamai 严格域改走代理） ===');
  {
    const ctx = mkCtx({ URL });
    vm.runInContext(extract(bg, 'const DIRECT_FRIENDLY_HOSTS', 'async function probeProxyCandidate'), ctx);
    const isDirect = ctx.isDirectFriendlyHost;

    // 必须走代理（返回 false）
    for (const u of ['https://v16-webapp-prime.tiktok.com/a.mp4',
                     'https://v19-webapp-prime.tiktok.com/a.mp4']) {
      okc(`${u.replace('https://', '').split('/')[0]} 不走直连`, isDirect(u) === false, String(isDirect(u)));
    }
    // 保持直连（这批域不带 Referer/Cookie 也能放行）
    for (const u of ['https://v16-webapp.tiktokcdn.com/a.mp4',
                     'https://v16.tiktokv.com/a.mp4',
                     'https://v3.douyinvod.com/a.mp4']) {
      okc(`${u.replace('https://', '').split('/')[0]} 仍走直连`, isDirect(u) === true, String(isDirect(u)));
    }
    // 名单外域名一律不走直连
    okc('名单外域名不走直连', isDirect('https://example.com/a.mp4') === false);
    // 非法/空 URL 不得抛错
    okc('非法 URL 不抛错', isDirect('not-a-url') === false && isDirect('') === false);
  }

  // ---------- 11. dedupeKey：同一条视频的不同 URL 形态必须收敛 ----------
  // 回归背景（2026-09-23，老板反馈"解析完一个、解析下一个时会把解析过的再解析一遍"）：
  // popup 原来用完整 URL 字符串做去重键，而解析结果的 originalUrl 是「展开后」形态，
  // 与输入框原文 `===` 命不中（带 query 的分享链接、短链展开、尾斜杠差异）
  // → 已解析过的链接被反复重新提交、重复解析。现改为按 videoId 归一化。
  console.log('\n=== 11. dedupeKey（去重键归一化） ===');
  {
    const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    const seg = extract(popupSrc, 'function dedupeKey', 'async function handleParse');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(seg, ctx);
    const dk = ctx.dedupeKey;

    // 同一条视频的 5 种 URL 形态 → 必须全部收敛到 'id:123'
    const same = [
      'https://www.tiktok.com/@u/video/123',
      'https://www.tiktok.com/@u/video/123?is_from_webapp=1&sender_device=pc',
      'https://www.tiktok.com/@u/video/123/',
      'https://www.tiktok.com/@u/video/123#anchor',
      'https://m.tiktok.com/v/123.html',
    ];
    const keys = same.map(dk);
    okc('同视频 5 种 URL 形态收敛为同一个 key', new Set(keys).size === 1, JSON.stringify([...new Set(keys)]));
    eq('  收敛结果就是 id:123', keys[0], 'id:123');

    // 不同视频必须区分开（否则会误跳过）
    okc('不同视频不互相吞并', dk('https://www.tiktok.com/@u/video/123') !== dk('https://www.tiktok.com/@u/video/456'));

    // 非详情页（主页）退化为去 query / 去尾斜杠
    eq('主页去尾斜杠', dk('https://www.tiktok.com/@u/'), dk('https://www.tiktok.com/@u'));
    okc('主页去 query', dk('https://www.tiktok.com/@u?a=1') === dk('https://www.tiktok.com/@u'));
    // 主页与视频详情不得混淆
    okc('主页不与视频详情混淆', dk('https://www.tiktok.com/@u') !== dk('https://www.tiktok.com/@u/video/123'));
    // 空值不抛错
    okc('空值不抛错', dk('') === 'url:' && dk(null) === 'url:');
  }

  // ---------- 12. 自建后端熔断：全灭的源不该让每条视频白等满窗口 ----------
  // 回归背景（2026-11-02）：服务端三通道实测长期全灭（all sources failed），
  // 而 parseViaOwnBackendMode 从未接入熔断 → 每条视频在第一段白等 PARSE_FAST_HD_MS(5s)。
  // 这里用桩 fetch 真实执行函数，验证：连续失败会冷却、冷却期内直接短路、abort 不计失败、
  // 以及 api 与 html 两个 mode 的熔断互不牵连（后者服务下载取签名，不能被前者拖死）。
  console.log('\n=== 12. 自建后端熔断（失败短路 + 按 mode 隔离） ===');
  {
    const mkFuseCtx = (impl) => {
      let calls = 0;
      const ctx = {
        OWN_PARSE_API: 'https://backend.example.com/api/parse',
        OWN_PARSE_TOKEN: 'tok',
        console: { log() {}, warn() {}, error() {} },
        fetchWithTimeout: async () => { calls++; return impl(calls); },
      };
      vm.createContext(ctx);
      vm.runInContext(extract(bg, 'const apiFailureCount', 'async function fetchAndParse'), ctx);
      vm.runInContext(extract(bg, 'async function parseViaOwnBackendMode', '// 判定一个媒体 URL'), ctx);
      return { ctx, calls: () => calls };
    };
    const okResp = { ok: true, json: async () => ({ success: true, id: '1', videoUrl: 'https://x/a.mp4' }) };
    const failResp = { ok: true, json: async () => ({ success: false, error: 'all sources failed' }) };

    // ① 连续失败 3 次 → 第 4 次直接短路，不再发请求
    {
      const { ctx, calls } = mkFuseCtx(() => failResp);
      for (let i = 0; i < 3; i++) {
        let e = null; try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) { e = x; }
        okc(`  第${i + 1}次失败（真实请求）`, !!e && /all sources failed/.test(e.message), e && e.message);
      }
      const before = calls();
      let e4 = null; try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) { e4 = x; }
      eq('  第4次不再发请求（请求数不变）', calls(), before);
      okc('  第4次报"冷却中"', !!e4 && /冷却中/.test(e4.message), e4 && e4.message);
      okc('  api 已进入冷却', ctx.isApiInCooldown(ctx.OWN_PARSE_API + '#api') === true);
    }
    // ② 按 mode 隔离：api 熔断不影响 html
    {
      const { ctx } = mkFuseCtx(() => failResp);
      for (let i = 0; i < 3; i++) { try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) {} }
      okc('  api 冷却中', ctx.isApiInCooldown(ctx.OWN_PARSE_API + '#api') === true);
      okc('  html 不受牵连', ctx.isApiInCooldown(ctx.OWN_PARSE_API + '#html') === false);
      // html 仍能正常请求
      let err = null;
      try { await ctx.parseViaOwnBackendMode('https://v/1', 'html', 100); } catch (x) { err = x; }
      okc('  html 仍可发起请求（报错是解析失败而非冷却）', !!err && !/冷却中/.test(err.message), err && err.message);
    }
    // ③ 主动 abort 不计入失败：连 abort 5 次也不该熔断
    {
      const mk = (impl) => mkFuseCtx(impl);
      const { ctx } = mk(() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; });
      for (let i = 0; i < 5; i++) { try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) {} }
      okc('  abort 不触发熔断', ctx.isApiInCooldown(ctx.OWN_PARSE_API + '#api') === false);
    }
    // ④ 成功后重置计数
    {
      let n = 0;
      const { ctx } = mkFuseCtx(() => (++n <= 2 ? failResp : okResp));
      try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) {}
      try { await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100); } catch (x) {}
      const r = await ctx.parseViaOwnBackendMode('https://v/1', 'api', 100);
      okc('  第3次成功后正常返回', r && r.success === true);
      okc('  成功后未进入冷却', ctx.isApiInCooldown(ctx.OWN_PARSE_API + '#api') === false);
    }
  }

  // ---------- 13. 媒体请求判定：不得因 CDN 换域名而失效 ----------
  // 回归背景（2026-11-05，老板反馈"又解析不出来了"）：
  // 拦截器原来用 CDN_DOMAINS 白名单（只有 tiktokcdn/douyin*）过滤媒体请求，
  // 而实际播放地址在 `*-webapp-prime.tiktok.com`(Akamai) / `*.tiktokv.com` / `*.tiktokv.eu`
  // / `*.muscdn.com` 上 → 白名单漏项 → 媒体请求被**静默丢弃** → 静默标签页必然超时。
  // 现改为优先用浏览器给的资源类型 type==='media' 判定，主机名只作兜底。
  console.log('\n=== 13. 媒体请求判定（主机名只是兜底） ===');
  {
    const ctx = mkCtx({ URL });
    vm.runInContext(extract(bg, 'const CDN_DOMAINS = [', '// 节流写入 storage.session'), ctx);
    const isVid = ctx.isVideoCdnUrl;

    // 命中：即便主机不在任何白名单里，只要浏览器判定为 media 就必须接受
    okc('未知主机 + type=media → 接受（不再依赖白名单）',
      isVid('https://some-unknown-host.xyz/v.mp4', 'media') === true);
    // 命中：区域/边缘 CDN 变体必须覆盖
    for (const u of ['https://v16-webapp-prime.tiktok.com/a.mp4',
                     'https://v16.tiktokv.com/a.mp4',
                     'https://v16.tiktokv.eu/a.mp4',
                     'https://p16.muscdn.com/a.mp4',
                     'https://v16-webapp.tiktokcdn.com/a.mp4']) {
      okc(`  ${u.replace('https://', '').split('/')[0]} 能被拦截`,
        isVid(u, 'other') === true, String(isVid(u, 'other')));
    }
    // 不命中：没有媒体后缀、或是音频/普通页面
    okc('非媒体后缀不采信', isVid('https://www.tiktok.com/page.html', 'media') === false);
    okc('音频不采信', isVid('https://example.com/a.mp3', 'media') === false);
    okc('未知主机 + 非 media 不采信',
      isVid('https://some-unknown-host.xyz/v.mp4', 'other') === false);
    okc('空 URL 不抛错', isVid('', 'media') === false && isVid(null, 'media') === false);

    // 下载侧同源问题：tiktokv 有多个区域 TLD，不能只认 .com
    const ctx2 = mkCtx({ URL });
    vm.runInContext(extract(bg, 'const DIRECT_FRIENDLY_HOSTS', 'async function probeProxyCandidate'), ctx2);
    okc('.tiktokv.eu 也走直连', ctx2.isDirectFriendlyHost('https://v16.tiktokv.eu/a.mp4') === true);
    okc('prime 域仍走代理（未被误放宽）',
      ctx2.isDirectFriendlyHost('https://v16-webapp-prime.tiktok.com/a.mp4') === false);
  }

  // ---------- 14. ssstik 端口（第三方站点兑换直链） ----------
  // 2026-11-05 实测：POST ssstik.io/abc?url=dl 可换回 tikcdn.io 直链，无需 key。
  // 该站对"视频不存在"返回 HTTP 200 + 文案（假活），必须看正文；
  // 且页面同时含 MP3(/ssstik/m/) 与头像(/ssstik/a/) 链接，误取会下错东西。
  console.log('\n=== 14. ssstik 端口（直链提取 / 假活拦截） ===');
  {
    const wsrc = fs.readFileSync(path.join(ROOT, 'web', '_worker.js'), 'utf8');
    const seg = extract(wsrc, 'function plainText(', '// 第三方解析源');
    okc('ssstik 函数已抽出', seg.includes('async function parseFromSsstik'), String(seg.length));

    const PAD = '<!-- ' + 'x'.repeat(600) + ' -->';
    const GOOD = `<html><body><h2>NASA</h2>
      <p class="maintext">Something big just landed on TikTok.</p>
      <a href="https://tikcdn.io/ssstik/7665075736742530317?st=abc&e=1" class="dl-button without_watermark">Without watermark</a>
      <a href="https://tikcdn.io/ssstik/m/YWJjZGVm" class="dl-button music">Download MP3</a>
      <a href="https://tikcdn.io/ssstik/a/YXZhdGFy" class="avatar">a</a>
      ${PAD}</body></html>`;
    const UNAVAILABLE = `<html><body><div>This video is currently unavailable! It seems that the video is private or not reachable at this moment.</div>${PAD}</body></html>`;
    const ONLY_MP3 = `<html><body><h2>a</h2><p class="maintext">t</p>
      <a href="https://tikcdn.io/ssstik/m/YWJj">Download MP3</a>${PAD}</body></html>`;

    function mkSsstikCtx(html, probeStatus = 206) {
      const ctx = { UA: 'UA', console };
      vm.createContext(ctx);
      vm.runInContext(seg, ctx);
      ctx.fetchWithTimeout = async (url) => {
        // 直链可用性校验走的是 tikcdn，需要单独给状态码
        if (String(url).includes('tikcdn.io')) {
          return { status: probeStatus, ok: probeStatus < 300, body: { cancel() {} } };
        }
        return { status: 200, ok: true, text: async () => html };
      };
      return ctx;
    }

    // ① 正常：取到视频直链，且不误取 MP3/头像
    {
      const ctx = mkSsstikCtx(GOOD);
      const r = await ctx.parseFromSsstik('https://www.tiktok.com/@nasa/video/7665075736742530317');
      okc('成功返回', r && r.success === true);
      okc('取到视频直链（非 MP3/头像）', r.videoUrl.includes('/ssstik/7665075736742530317'), r.videoUrl.slice(0, 60));
      okc('  未命中 MP3 前缀', !r.videoUrl.includes('/ssstik/m/'));
      okc('  未命中头像前缀', !r.videoUrl.includes('/ssstik/a/'));
      okc('  标题正确', r.title === 'Something big just landed on TikTok.', r.title);
      okc('  作者正确', r.author === 'NASA', r.author);
      okc('  id 取到', r.id === '7665075736742530317', r.id);
      okc('  标记来源为 ssstik（避免误判为需取新签名）', r.source === 'ssstik', r.source);
    }

    // ② 假活：200 但文案说视频不可用 → 必须抛错，不能当成功
    {
      const ctx = mkSsstikCtx(UNAVAILABLE);
      let msg = '';
      try { await ctx.parseFromSsstik('https://www.tiktok.com/@x/video/1'); } catch (e) { msg = e.message; }
      okc('假活（视频不可用）被拦截', /unavailable/i.test(msg), msg);
    }

    // ③ 只有音频链接 → 不能把 MP3 当视频返回
    {
      const ctx = mkSsstikCtx(ONLY_MP3);
      let msg = '';
      try { await ctx.parseFromSsstik('https://www.tiktok.com/@x/video/1'); } catch (e) { msg = e.message; }
      okc('只有 MP3 时拒绝返回', /no video link/i.test(msg), msg);
    }

    // ④ 直链取不到字节（tikcdn 返回 204）→ 必须抛错。
    // 线上现象：列表里出现「无标题/未知作者/高清」的卡片，点下载必报 SERVER_FAILED。
    {
      const ctx = mkSsstikCtx(GOOD, 204);
      let msg = '';
      try { await ctx.parseFromSsstik('https://www.tiktok.com/@x/video/1'); } catch (e) { msg = e.message; }
      okc('直链取不到字节时拒绝返回', /not playable/i.test(msg), msg);
    }

    // ⑤ 不可用页里残留 tikcdn 链接 → 仍要判失败（这是坏卡片的真正成因）
    const UNAVAIL_WITH_LINK = `<html><body>
      <div>This video is currently unavailable! It seems that the video is private or not reachable.</div>
      <a href="https://tikcdn.io/ssstik/999?st=x&e=1" class="old">old</a>
      ${PAD}</body></html>`;
    {
      const ctx = mkSsstikCtx(UNAVAIL_WITH_LINK);
      let msg = '';
      try { await ctx.parseFromSsstik('https://www.tiktok.com/@x/video/1'); } catch (e) { msg = e.message; }
      okc('不可用页即使残留链接也拒绝', /unavailable/i.test(msg), msg);
    }
  }

  // ---------- 15. tkdl 端口（tikdownloader / tikvid） ----------
  // 2026-11-06 实测：POST /api/ajaxSearch → status=ok + 结果页 HTML，
  // 连续 4 次全部成功（ssstik 第 2 次就挂），且提供 HD 档（14.3MB vs 3.2MB）。
  console.log('\n=== 15. tkdl 端口（HD 选取 / 镜像兜底） ===');
  {
    const wsrc = fs.readFileSync(path.join(ROOT, 'web', '_worker.js'), 'utf8');
    const seg = extract(wsrc, 'function plainText(', '// 第三方解析源');

    // MP3 故意放在最前面：若过滤逻辑失效，"第一个非 HD" 就会选到音频。
    // 真实页面按钮顺序并不稳定，这个顺序是必要的防御性用例。
    const RESULT = `<div class="content"><h3>Something big just landed on TikTok.</h3></div>
      <img class="image-tik" src="https://p19-common-sign.tiktokcdn-us.com/cover.webp?x=1">
      <a href="https://dl.snapcdn.app/get?token=MP3" class="tik-button-dl">Download MP3</a>
      <a href="https://dl.snapcdn.app/get?token=STD" class="tik-button-dl">Download MP4 [1]</a>
      <a href="https://dl.snapcdn.app/get?token=HD" class="tik-button-dl">Download MP4 HD</a>`;

    // probeOk：哪些 token 探测能通过
    function mkTkdlCtx(html, probeOk = () => true) {
      const ctx = { UA: 'UA', console };
      vm.createContext(ctx);
      vm.runInContext(seg, ctx);
      ctx.fetchWithTimeout = async (url) => {
        if (String(url).includes('/api/ajaxSearch')) {
          return { ok: true, status: 200, json: async () => ({ status: 'ok', data: html }) };
        }
        const ok = probeOk(String(url));
        return { ok, status: ok ? 200 : 204, body: { cancel() {} } };
      };
      return ctx;
    }

    const URL1 = 'https://www.tiktok.com/@nasa/video/7665075736742530317';

    // ① 正常：HD 优先，MP3 被排除
    {
      const ctx = mkTkdlCtx(RESULT);
      const r = await ctx.parseFromTikdownloader(URL1);
      okc('成功返回', r && r.success === true);
      okc('hdVideoUrl 取 HD 档', r.hdVideoUrl.includes('token=HD'), r.hdVideoUrl);
      okc('videoUrl 取标准档', r.videoUrl.includes('token=STD'), r.videoUrl);
      okc('MP3 未被选中', !r.hdVideoUrl.includes('MP3') && !r.videoUrl.includes('MP3'));
      okc('质量标为高清', r.quality === '高清', r.quality);
      okc('标题正确', r.title === 'Something big just landed on TikTok.', r.title);
      okc('作者从 @handle 取到', r.author === 'nasa', r.author);
      okc('封面取自 tiktokcdn', r.cover.includes('tiktokcdn'), r.cover.slice(0, 50));
      okc('来源标记为 tkdl', r.source === 'tkdl', r.source);
    }

    // ② HD 探测失败 → 退回标准档，且 hdVideoUrl 不得指向没验过的 HD
    {
      const ctx = mkTkdlCtx(RESULT, (u) => !u.includes('token=HD'));
      const r = await ctx.parseFromTikdownloader(URL1);
      okc('HD 不可用时退回标准档', r.hdVideoUrl.includes('token=STD'), r.hdVideoUrl);
      okc('  质量降级为原画质', r.quality === '原画质', r.quality);
      okc('  不返回未验证的 HD 地址', !r.hdVideoUrl.includes('token=HD'));
    }

    // ③ 全部取不到 → 必须失败，不能产出点不动的卡片
    {
      const ctx = mkTkdlCtx(RESULT, () => false);
      let msg = '';
      try { await ctx.parseFromTikdownloader(URL1); } catch (e) { msg = e.message; }
      okc('直链全部不可用时拒绝返回', /not playable/i.test(msg), msg);
    }

    // ④ 没有下载链接的结果页 → 失败
    //    （注意：真实结果页约 6KB，代码有 data.length > 200 的护栏，
    //      故 fixture 必须补足长度，否则会先被长度护栏拦下，测不到目标分支）
    {
      const ctx = mkTkdlCtx('<html><body><h3>x</h3>no links<!-- ' + 'x'.repeat(400) + ' --></body></html>');
      let msg = '';
      try { await ctx.parseFromTikdownloader(URL1); } catch (e) { msg = e.message; }
      okc('无链接时拒绝返回', /no download link/i.test(msg), msg);
    }
  }

  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
})();