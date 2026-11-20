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
const API_BASE = 'https://tiktok-downloader-av8.pages.dev';
// token 的单一真源是 web/_worker.js（部署侧）；这里读出后与其他文件比对，
// 避免 selfcheck 自身成为第 4 个需要手工同步 token 的地方。
const TOKEN = (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'web/_worker.js'), 'utf8');
    const m = src.match(/const TOKEN = '([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
})();

let pass = 0, fail = 0;
const ok = (msg) => { pass++; console.log('  ✅ ' + msg); };
const bad = (msg) => { fail++; console.log('  ❌ ' + msg); };

console.log('=== 1. 语法检查 ===');
// 注：common.js 已移除（从未被 manifest/content_scripts/importScripts 加载，
// 且 background.js 内已内联同名实现，属重复死代码）
const jsFiles = ['background.js', 'popup.js', 'content.js', 'web/index.html', 'web/_worker.js', 'worker-proxy.js'];
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
    ['下载专用取新签名（更长窗口）', bg.includes('fetchFreshDownloadUrls') && bg.includes('freshUrl')],
    ['直连白名单分流', bg.includes('isDirectFriendlyHost')],
    // 【2026-09-21】Akamai 严格域（*-webapp-prime.tiktok.com）必须排除在直连之外：
    // 该域要求 Referer/Cookie，而 chrome.downloads 无法携带 Referer
    // （forbidden header，DownloadOptions 亦无 referrer 参数）→ 直连必然 403，
    // 还要白等满 FIRST_STALL_CHECK_MS(30s) 才降级代理。行为由 behavior_test 第 10 节执行验证。
    ['直连白名单排除 Akamai 严格域',
      /if \(h === 'webapp-prime\.tiktok\.com' \|\| h\.endsWith\('-webapp-prime\.tiktok\.com'\)\) return false;/.test(bg)],
    // 【2026-11-05】媒体请求判定不得依赖 CDN 白名单：
    // 原实现只用 CDN_DOMAINS（tiktokcdn/douyin*）过滤，而实际播放地址在
    // *-webapp-prime.tiktok.com / *.tiktokv.com / *.tiktokv.eu / *.muscdn.com 上
    // → 媒体请求被静默丢弃 → 静默标签页必然超时（表现为"解析不出来"）。
    // 现改为优先用浏览器给的 type==='media' 判定，主机名仅作兜底。
    ['媒体判定以 type=media 为主（不依赖域名白名单）',
      /function isVideoCdnUrl\(url, type\)[\s\S]{0,400}if \(type === 'media'\) return true;/.test(bg)],
    ['媒体判定覆盖区域 CDN 变体',
      /const CDN_DOMAINS = \[[\s\S]{0,300}'tiktokv\.'[\s\S]{0,300}'muscdn'[\s\S]{0,300}'webapp-prime\.tiktok\.com'/.test(bg)],
    ['拦截器把资源类型传入判定', bg.includes('isVideoCdnUrl(url, type)')],
    ['tiktokv 支持多区域 TLD（.eu 等）',
      /\/\(\^\|\\\.\)tiktokv\\\.\[a-z\.\]\+\$\/\.test\(h\)/.test(bg)],
    ['静默标签页失败带现场诊断',
      bg.includes('diagnoseSilentTab') && bg.includes("'s 超时）｜' + diag")],
    // 【2026-11-05】深挖注入必须限次：原条件「>600ms 且无结果」+ 200ms 轮询
    // → 每 200ms 注入一次脚本，8 个静默页并发时每秒数十次注入，
    // 与播放器初始化抢主线程，页面发不出媒体请求 → 自己把自己拖到超时。
    ['深挖注入限次（递增间隔，最多 4 次）',
      bg.includes('const DEEP_AT_MS = [600, 2000, 5000, 9000];')
      && bg.includes('deepIdx < DEEP_AT_MS.length && elapsed >= DEEP_AT_MS[deepIdx]')],
    ['代理探测防坏成功', bg.includes('probeProxyCandidate')],
    ['去 HLS 候选', bg.includes('hlsCandidates')],
    ['多候选下载链', bg.includes('const candidates = []')],
    ['代理失败重试（多轮+退避）', bg.includes('attempt < PROXY_DL_ATTEMPTS') && bg.includes('await sleep(attempt === 1 ? 600 : 1500)')],
    ['卡死超时不杀大文件', bg.includes('checkTimeout')],
    ['单视频预算防堵队列', bg.includes('EFFORT_MS') && bg.includes('_gaveUp')],
    ['强制无水印（默认不放水印，3次后降级）', bg.includes('looksWatermarked') && bg.includes('wmCandidates')],
    ['原画质失败3次自动降级', bg.includes('originalQualityFailCounts') && bg.includes('allowFallback')],
    ['图集代理兜底', bg.includes('OWN_PROXY_API + encodeURIComponent(imageUrl)')],
    ['recommend-auto-parse 监听', bg.includes("type === 'recommend-auto-parse'")],
    ['download-single 监听', bg.includes("type === 'download-single'")],
    ['download-all-background 监听', bg.includes("type === 'download-all-background'")],
    ['两段式解析（5s快源 / 4s本地通道）', bg.includes('PARSE_FAST_HD_MS = 5000') && bg.includes('PARSE_ORIG_MS = 4000')],
    // 【2026-11-05 修正】09-17 曾把服务端 html 判为"已死"并移出主链路，
    // 实际是当时的测试视频本身失效（oembed 200 但 ssstik 明确报 unavailable），
    // 把"视频不存在"误读成了"通道失效"。11-05 用有效视频复测：html 可稳定返回真实
    // playAddr（约 2s）。现把它与 ssstik、api 一起放在**第一段**竞速。
    ['第一段竞速包含自研四端口（tkdl/ssstik/html/api）',
      /for \(const ownMode of \['tkdl', 'ssstik', 'html', 'api'\]\)/.test(bg)],
    // 【2026-11-18】第一段不能"谁快用谁"：html 最快但返回的 prime CDN 地址
    // 签名绑 tt_chain_token（匿名拿不到）→ 我们的代理必 403，
    // 用户侧表现是「解析成功、下载报服务器错误」。必须优先可下载的源。
    ['第一段按"可下载"优先而非速度', bg.includes('function racePreferDownloadable')],
    ['tkdl/ssstik 被标为首选源', /PREFERRED_MODES = new Set\(\['tkdl', 'ssstik'\]\)/.test(bg)],
    // 【2026-11-19】prime 地址必 403（签名绑 tt_chain_token，JS 运行时才有），
    // 既不能当最终结果，也不能让用户点一个注定失败的下载按钮。
    ['识别 prime 不可下载地址', bg.includes('function isPrimeCdnUrl')],
    ['prime 结果触发 tkdl 长窗口重试',
      bg.includes('TKDL_RETRY_MS') && bg.includes("parseViaOwnBackendMode(finalUrl, 'tkdl', TKDL_RETRY_MS)")],
    ['下载层对 prime 地址给出明确提示',
      bg.includes('function primeDownloadBlockReason') && bg.includes('const blockReason = primeDownloadBlockReason(video, url)')],
    ['浏览器会话地址不受该限制',
      bg.includes('function isBrowserCapturedSource') && bg.includes('BROWSER_CAPTURED_SOURCES')],
    // 【2026-11-20】熔断不能把「这条视频取不到」当成「通道故障」：
    // 否则 3 条无解视频就把 tkdl 冷掉 5 分钟，期间结果全退回 html 的 prime 地址
    // → 用户看到「刚才还高清，突然全变原画质」。
    ['视频级失败不触发熔断',
      bg.includes('function isVideoSpecificFailure') && bg.includes('!isVideoSpecificFailure(e)')],
    ['首选源冷却时间更短', bg.includes('function cooldownMsFor') && bg.includes('#(tkdl|ssstik)$')],
    // 第二段仍只跑"不用开页"的本地通道；服务端 mode 属于第一段，不得回插第二段
    ['第二段不再调用失效的服务端 html/item 源',
      !/origSources\.push\(parseViaOwnBackendMode\(finalUrl, '(html|item)'/.test(bg)],
    ['第二段保留本地三通道（拦截/页面深挖/FetchHTML）',
      bg.includes('parseViaIntercept(finalUrl).then(finalize)')
      && bg.includes('parseViaPageDeep(finalUrl).then(finalize)')
      && bg.includes('parseViaFetchHtml(finalUrl, stage2Abort.signal)')],
    // ===== 静默标签页通道（第二段 B）：服务端源失效后唯一能稳定拿原画质的路径 =====
    // 它用真实浏览器打开视频页，让 webRequest 拦截器抓到 playAddr —— 走用户自己的
    // 出口 IP 与登录态，因此绕过了服务端直抓所遭遇的 TikTok 403 风控。
    // 代价是必须严格约束资源：标签页要关、槽位要还、落地视频要核对。
    ['静默标签页通道已接入第二段', /parseViaSilentTab\(finalUrl, SILENT_TAB_TIMEOUT_MS\)/.test(bg)],
    // 语义断言：静默通道必须有独立于第一段的超时常量，且窗口应明显长于第一段
    //（它要真实加载页面，沿用第一段的 5s 会大面积误杀）。
    // 不硬编码具体数值——窗口会随实测调整（2026-11-02 由 9s 调到 13s 就曾误报）。
    ['静默标签页超时独立于第一段', (() => {
      const m = bg.match(/const SILENT_TAB_TIMEOUT_MS = (\d+)/);
      const f = bg.match(/const PARSE_FAST_HD_MS = (\d+)/);
      return !!m && !!f && Number(m[1]) > Number(f[1]);
    })()],
    // 自建后端必须接入熔断：否则长期全灭的源会让每条视频白等满窗口
    ['自建后端接入熔断', bg.includes('const fuseKey = OWN_PARSE_API') && bg.includes('isApiInCooldown(fuseKey)')],
    ['熔断不误伤主动取消', bg.includes('if (!aborted && !isVideoSpecificFailure(e)) recordApiFailure(fuseKey)')],
    // 标签页泄漏是这条通道最危险的失效模式：长批量下会开出成百上千个后台页，
    // 因此关闭动作写在 finally 里（单一出口），不能分散在各 catch 分支。
    ['静默标签页必关（finally 单一出口）',
      /async function parseViaSilentTab[\s\S]*?finally \{[\s\S]*?chrome\.tabs\.remove\(tabId\)/.test(bg)],
    ['静默标签页关闭后清理拦截缓存', /chrome\.tabs\.remove\(tabId\)[\s\S]{0,200}capturedVideoUrls\.delete\(tabId\)/.test(bg)],
    // TikTok 会重定向到推荐流并自动播放别的视频，不核对就会"下载到错误内容"
    ['静默标签页核对落地 videoId', bg.includes('silent tab: 落地视频不一致')],
    // 非详情页（主页/推荐页）没有确定的目标视频，开页只会抓到推荐流内容
    ['静默标签页拒绝非详情页', bg.includes('silent tab: 非视频详情页，跳过')],
    ['静默标签页并发受控', bg.includes('_acquireSilentSlot()') && bg.includes('SILENT_TAB_MAX_CONCURRENT')],
    // 槽位上限若低于解析池的大批量宽度（8），放宽解析池将零收益：
    // 实测 1370 条下 4 槽 ≈103 分钟、8 槽 ≈51 分钟。二者必须对齐。
    ['静默槽位与解析池宽度对齐（8）',
      bg.includes('SILENT_TAB_MAX_CONCURRENT = 8')
      && /parsePending\.length > 6 \? 8 : PARSE_POOL/.test(bg)],
    // 深挖默认取"当前激活标签页"，而静默页是 active:false —— 不显式传 tabId 会读错页面
    ['静默标签页深挖显式传 tabId', bg.includes('parseViaPageDeep(finalUrl, tabId)')],
    // 槽位归还必须无条件执行，否则并发池被逐步饿死（配 slot 释放断言）
    ['静默标签页槽位无条件归还', /finally \{[\s\S]{0,400}_releaseSilentSlot\(\);/.test(bg)],
    // ===== 质量标签按「实际取的地址」判定，不按来源硬贴（2026-09-17 修）=====
    // 用户截图「怎么全是原画质」的根因：两个 parse 函数都用
    // `item.source === 'universal' ? '原画质' : '高清'` 无条件覆写，而 universal/sigi
    // 优先级最高、TikTok 视频页必然含 __UNIVERSAL_DATA__ → 几乎全部被误标原画质。
    ['不再按来源无条件覆写质量',
      !/info\.quality = item\.source === '(?:fetch_)?(?:universal|sigi)'/.test(bg)
      && (bg.match(/info\.quality = info\.quality\s*\n?\s*\|\|/g) || []).length === 2],
    // extractVideoInfo 必须依据实际字段判定，且判不出时留空（不能硬编码原画质）
    ['extractVideoInfo 按实际字段判定质量', bg.includes("let qualityHint = ''")],
    ['  取到高清字段时标记高清', bg.includes("qualityHint = '高清'")],
    // extractVideoInfo 内不得再硬编码 '原画质'：那是"来源"语义，会让调用方拿不到"未判定"信号。
    // 注：parseViaIntercept / parseViaSilentTab 里各有一处 '原画质' 是**正确**的
    //（那两条通道确实只产出原画质），因此只对 extractVideoInfo 函数体做检查。
    ['  判不出质量时返回空串',
      (() => {
        const a = bg.indexOf('async function extractVideoInfo');
        const b = bg.indexOf('async function detectLanguage', a);
        const seg = a >= 0 && b > a ? bg.slice(a, b) : '';
        return seg.includes('quality: qualityHint,') && !/quality: '原画质'/.test(seg);
      })()],
    // ===== 短命签名源改为精确列举，不再用宽泛前缀（2026-09-17 修）=====
    // 原 /fetch_/ 前缀会把 fetch_next（明确的高清来源）一并吞掉，`page` 子串同样过宽。
    ['短命签名源集中定义', bg.includes('const SHORT_LIVED_SOURCES = new Set([')],
    ['短命签名源为精确列举', bg.includes('function isShortLivedSource(video)')],
    ['已移除过宽的 fetch_ 前缀判定',
      !/intercept\|universal\|sigi\|own_backend\|fetch_\|_page\|page/.test(bg)],
    // 两处判定必须都改走统一函数，避免再次分叉（这两行的条件各不相同，逐条断言）
    ['两处判定统一走 isShortLivedSource',
      bg.includes("const isOrigQuality = /原画质/.test(String(video.quality || '')) || isShortLivedSource(video);")
      && bg.includes('|| isShortLivedSource(video);')],
    ['3 并发解析池', bg.includes('PARSE_POOL') && bg.includes('pumpUntilIdle')],
    // ===== 下列为「已修复缺陷」的回归防线：这些不变量被破坏时应当立刻报错 =====
    ['拦截结果校验 videoId（防下载到错误视频）', bg.includes('intercept video id mismatch')],
    ['页面深挖同规则校验 videoId', bg.includes("urlId !== tabId")],
    ['熔断 key 为 API 主机名', bg.includes('function apiKey(')],
    ['cachedVideos 单一写入口', bg.includes('function mutateCachedVideos(') && !bg.includes('_cacheSaveQueue')],
    ['竞速命中即取消落败请求', bg.includes('stage1Abort') && bg.includes('stage2Abort')],
    ['下载进度启动对账', bg.includes('function reconcileDownloadProgress(')],
    ['文件名安全化（长度/尾字符）', bg.includes('function safeFileName(')],
    ['候选地址协议校验', bg.includes('非 http(s) 地址一律丢弃')],
    ['OWN_PROXY_API 带 token', /OWN_PROXY_API = '[^']*token=/.test(bg)],
    ['stop 用批次标记而非全局变量', bg.includes('while (!task.stopped)') && !bg.includes('stopParseRequested')],
    // ===== 针对「下载报服务器错误」的修复（2026-09-16 二轮）=====
    ['代理候选多次重试（抗 CDN 间歇风控）', bg.includes('PROXY_DL_ATTEMPTS')],
    ['代理探测可读到结构化错误体', bg.includes("{ headers: { 'Range': 'bytes=0-0' } }")],
    ['下载失败必留痕（控制台）', bg.includes('[下载失败]')],
    ['展示字段归一化（时间戳/点赞数）', bg.includes('展示字段归一化')],
    // ===== 进度口径：展示「未成功数」而非「已处理数」（2026-09-17）=====
    // completed 会把失败项也算作已完成，进度看着在涨、实际没产出；
    // pending 由后端口径计算，UI 只读它。
    ['进度暴露未成功数 pending', bg.includes('task.pending = Math.max(0, task.total - results.length - skippedCount)')],
    ['并入新任务时 pending 同步增长', /parseTask\.pending = \(parseTask\.pending \|\| 0\) \+ items\.length/.test(bg)],
    ['收尾时 pending 归零', /task\.status = 'done';[\s\S]{0,120}task\.pending = 0;/.test(bg)],
    ['中断提示按未完成数口径', bg.includes('剩余 ${pending} 项未完成')],
    // 【2026-11-05】失败原因必须一路传到用户眼前：
    // 原先 finalize 一律抛 'parse fail'、parseWithRetry 返回 { success:false } 不带 error、
    // 批次只记 failedUrls → 用户只看到「N 个失败」，无法区分超时/重定向/10204（修法完全不同）。
    ['finalize 保留原始错误', bg.includes("throw new Error((r && r.error) || 'parse fail')")],
    ['逐段收集失败原因', bg.includes('const failReasons = [];')],
    ['总失败返回带原因', /error: '所有解析源均失败' \+\s*\n?\s*\(failReasons\.length/.test(bg)],
    ['重试耗尽仍保留原因', bg.includes("return { success: false, error: lastError || '解析失败（无详情）' }")],
    ['批次记录失败原因', bg.includes('const failedReasons = [];') && bg.includes('const pushFail = (u, reason) =>')],
    ['失败原因落库供 UI 读取', bg.includes('task.failedReasons = failedReasons.slice(0, 20)')],
    // 【2026-11-18】Promise.any 全败时抛 AggregateError，.message 恒为
    // "All promises were rejected"，各源原因在 .errors 里 —— 必须展开，
    // 否则失败原因没有信息量。
    ['失败原因展开聚合错误', bg.includes('function describeError') && bg.includes("failReasons.push('高清段:' + describeError(e))")],
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
    ['媒体地址协议校验', popup.includes('function isHttpUrl')],
    ['失败信息转义（防 XSS）', popup.includes('escapeHtml(video.error)')],
    ['删除按 id 增量（防覆盖新结果）', popup.includes('latest.filter(v => v.id !== removed.id)')],
    // 进度文案必须走统一格式化函数，避免两处渲染口径再次分叉。
    // 调用点应为 2 处（初检 + storage 监听）；定义行也含同样的子串，故用 showStatus 前缀区分。
    ['进度文案统一走 formatParseProgress', (popup.match(/showStatus\(formatParseProgress\(/g) || []).length === 2],
    ['进度展示未成功数', popup.includes('条未成功')],
    // 【2026-11-05】批次结束后若有失败，必须把原因显示出来而不是静默隐藏状态栏，
    // 否则用户只能靠反复重试碰运气（无法区分超时/重定向/10204）。
    ['失败时展示具体原因', popup.includes('条解析失败${tail}') && popup.includes('progress.failedReasons')],
    // 【2026-09-23】去重键必须归一化：只用完整 URL 字符串比较会漏判"同一条视频的不同
    // URL 形态"（带 query 的分享链接 / 短链展开 / 尾斜杠），导致已解析的链接被反复重新解析。
    ['去重键归一化 dedupeKey', popup.includes('function dedupeKey(')],
    ['去重按 videoId 收敛', popup.includes('dedupeKey(u)') && popup.includes("known.add('id:' + String(v.id))")],
    ['不再用原始 URL 直接做去重键', !popup.includes(".map(v => v.originalUrl.replace(/\\/+$/, ''))")],
    // 【2026-09-24】自动解析不得往输入框写链接：原实现每次追加一条，
    // 浏览越多输入框积得越长、最后撑满（用户看到一堆自己没粘贴过的链接）。
    // 改为把目标显式传给 handleParse，输入框保持不动。
    ['自动解析不污染输入框',
      !popup.includes('lines.push(target)') && popup.includes('handleParse(false, true, [target])')],
    ['handleParse 支持显式传链接', popup.includes('explicitUrls = null')],
  ];
  for (const [name, v] of pchecks) v ? ok('popup: ' + name) : bad('popup: ' + name);
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const cchecks = [
    ['getCurrentVideoInfo 已定义', content.includes('function getCurrentVideoInfo')],
    ['isAutoParsePage 已定义', content.includes('function isAutoParsePage')],
    ['搜索页匹配', content.includes("path.startsWith('/search')")],
    ['recommend-auto-parse 发送', content.includes("type: 'recommend-auto-parse'")],
    ['DOM 变动防抖', content.includes('function scheduleMutate')],
    ['详情页排除（避免与 popup 重复解析）', content.includes('由 popup.js 的自动解析链路负责')],
    ['sendMessage 读取 lastError', content.includes('void chrome.runtime.lastError')],
  ];
  for (const [name, v] of cchecks) v ? ok('content: ' + name) : bad('content: ' + name);
}

console.log('=== 4. 功能链路（网页版 / 后端） ===');
{
  const w = fs.readFileSync(path.join(ROOT, 'web/_worker.js'), 'utf8');
  // 取出 ALLOWED 数组本体再断言：避免被注释里出现的域名（如反面示例）误判
  const allowedBlock = (w.match(/const ALLOWED = \[([\s\S]*?)\];/) || ['', ''])[1];
  const wchecks = [
    ['/api/parse 存在', w.includes('/api/parse')],
    ['/api/proxy 存在', w.includes('/api/proxy')],
    ['/api/diag-page 存在', w.includes('/api/diag-page')],
    // 【2026-11-05】新增自研端口：
    //   /api/meta  = TikTok 官方 oEmbed（免费无凭证，只补元数据）
    //   mode=ssstik = 第三方站点兑换直链（无需 key）
    // 同时 `html`（页面直抓）被 09-17 误判为"已死"而移出主链路，
    // 实为测试视频失效所致 —— 现已恢复并重新参与第一段竞速。
    ['/api/meta（oEmbed 元数据）存在', w.includes("'/api/meta'") && w.includes('function handleMeta(')],
    // oEmbed 字段已被 TikTok 裁剪（无 title/author_name），必须有 ssstik 兜底，
    // 否则该端点会「200 但全空」，属于假活。
    ['/api/meta 有 ssstik 兜底', w.includes("via = 'ssstik'")],
    ['mode=ssstik 端口存在', w.includes('async function parseFromSsstik(') && w.includes('runSsstik')],
    ['ssstik 假活拦截（看正文而非状态码）', w.includes("ssstik: video unavailable")],
    // 【2026-11-05 线上坏卡片】不可用页可能残留 tikcdn 链接 → 只判断"有无链接"会误判成功，
    // 产出「无标题/未知作者/高清」且点下载必 SERVER_FAILED 的卡片。
    // 现要求必须是真正的结果页（含 without_watermark 或 maintext）。
    ['ssstik 要求是真结果页', w.includes('ssstik: not a result page') && w.includes('isResultPage')],
    // 直链必须实测能取到字节（tikcdn 偶发 204/空体）
    ['ssstik 直链可用性校验', w.includes('ssstik: link not playable') && w.includes("'Range': 'bytes=0-0'")],
    // 【2026-11-06】新增 tkdl 端口：实测不限流（连续 4/4）、且有 HD 档（14MB vs 3.2MB）
    ['tkdl 端口存在', w.includes('async function parseFromTikdownloader(') && w.includes('runTkdl')],
    ['tkdl 有镜像站兜底', w.includes("'https://tikvid.io'") || w.includes('tikvid.io')],
    ['tkdl 直链可用性校验', w.includes('tkdl: link not playable')],
    ['代理放行 snapcdn', w.includes("'snapcdn.app'")],
    ['ssstik 排除 MP3/头像链接', w.includes('/\\/ssstik\\/(m|a)\\//')],
    ['ssstik 来源标记独立', w.includes("source: 'ssstik'")],
    ['TOKEN 一致', w.includes("const TOKEN = '" + TOKEN + "'")],
    ['UA 轮询（PROXY_UAS）', w.includes('PROXY_UAS')],
    ['CORS 头', w.includes('Access-Control-Allow-Origin')],
    ['CDN 白名单', w.includes('tiktokcdn-eu.com') && w.includes('webapp-prime.tiktok.com')],
    // 【2026-11-05】代理放行名单必须覆盖区域 TLD 与 ssstik 直链域，
    // 否则 ssstik 端口解析出来的地址会在下载时被判 domain not allowed。
    ['白名单含 tiktokv 区域 TLD', w.includes("'tiktokv.eu'") && w.includes("'tiktokv.us'")],
    ['白名单含 ssstik 直链域', w.includes("'tikcdn.io'")],
    ['代理 403 重试 cookie', w.includes('cookieCache = { value: \'\', at: 0 }')],
    // ===== 已修复缺陷的回归防线 =====
    ['代理鉴权（/api/proxy 校验 token）', /async function handleProxy[\s\S]*?checkToken\(url\)/.test(w)],
    ['代理 IP 限流', w.includes('rateLimitedProxy')],
    ['代理逐跳校验重定向', w.includes('function fetchMediaChecked(')],
    ['代理响应头白名单（不透传 Set-Cookie）', w.includes('SAFE_PROXY_HEADERS')],
    ['白名单不含无关静态资源域', allowedBlock.length > 0 && !allowedBlock.includes('gstatic')],
    ['cookie 并发去重', w.includes('cookieInflight')],
    // ===== 针对「下载报服务器错误」的修复（2026-09-16 二轮）=====
    ['上游取流带多轮重试', w.includes('UPSTREAM_MAX_ATTEMPTS') && w.includes('function fetchUpstream(')],
    ['200+HTML/JSON 错误页不算成功', w.includes('function looksLikeErrorPage(')],
    ['Range 仅在客户端携带时转发（不发空 Range）', w.includes('if (clientRange) baseHeaders')],
    ['HEAD 请求不回 body', w.includes("request.method === 'HEAD' ? null")],
  ];
  for (const [name, v] of wchecks) v ? ok('_worker: ' + name) : bad('_worker: ' + name);
  const idx = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const ichecks = [
    ['自建后端接入', idx.includes('parseViaOwnBackend')],
    ['OWN_PARSE_API 指向（绝对或同域相对）', idx.includes('/api/parse')],
    ['token 一致', idx.includes(TOKEN)],
    ['图集下载', idx.includes('albumUrls')],
    ['代理请求带 token', idx.includes("'/api/proxy?token='")],
    ['媒体域名白名单校验', idx.includes('function isMediaUrl')],
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
  // ===== 已修复缺陷的回归防线 =====
  // 不得再申请通配整个「共享域名」的主机权限（workers.dev / 免费 DNS 域），
  // 那类授权覆盖数百万第三方子域，属明显过度授权，也是上架审核的高风险项
  const overBroad = hosts.filter(h => /\*:\/\/\*\.(?:workers\.dev|tiklydown\.eu\.org|tiklydown\.top)\//.test(h));
  overBroad.length === 0 ? ok('host 无"共享域名"通配') : bad('host 存在过度授权通配: ' + overBroad.join(', '));
  // 文件大小回填会对 CDN 直接发 HEAD，需要对应主机权限
  hosts.some(h => h.includes('tiktokcdn-us.com')) ? ok('host: tiktokcdn-us（大小回填）') : bad('host 缺 tiktokcdn-us.com');
  // 死代码防线：common.js 从未被任何入口加载（manifest / content_scripts / importScripts），
  // 而 background.js 已内联同名实现。若要恢复它，必须同时把它接进加载顺序。
  !fs.existsSync(path.join(ROOT, 'common.js')) ? ok('无未加载的重复模块 common.js') : bad('common.js 存在但没有任何入口加载它');
  // Chrome 保留名防线：扩展目录「顶层」出现以 _ 开头的文件/目录时，
  // chrome://extensions 会直接拒绝加载（"Filenames starting with "_" are reserved"）。
  // 实测该检查只作用于顶层：web/_worker.js 这类子目录文件不受影响
  // （Cloudflare Pages 要求必须叫 _worker.js，故不能改名）。
  const reservedTop = fs.readdirSync(ROOT)
    .filter(n => n.startsWith('_') && n !== '_locales' && n !== '_metadata');
  reservedTop.length === 0
    ? ok('顶层无 Chrome 保留名（_ 开头）')
    : bad('顶层存在 Chrome 保留名，会导致扩展加载失败: ' + reservedTop.join(', '));
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

console.log('=== 8. 已修复缺陷的行为级回归测试（真实执行纯函数） ===');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'behavior_test.js')], { encoding: 'utf8' });
  const last = out.trim().split('\n').slice(-1)[0];
  if (last.includes('0 失败')) ok('behavior_test: ' + last);
  else bad('behavior_test 未全过: ' + last);
} catch (e) {
  bad('behavior_test 运行失败: ' + (e.stdout || e.message || '').toString().split('\n').slice(-2).join(' '));
}

console.log('\n========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail > 0 ? 1 : 0);
