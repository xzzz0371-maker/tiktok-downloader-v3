// ============================================================
// TikTok/抖音下载器 v3.1 - 后台服务
// 新增：网络请求拦截、页面深度解析、下载进度广播、下载逻辑优化
// v3.1：公共函数抽离到 common.js、API熔断、下载速度、下载历史、拦截持久化
// ============================================================
// 说明：不再以 ES module 方式 import（去掉 manifest 的 type=module），
// 两个格式化小函数直接内联，保证在 Firefox / 部分老内核浏览器也能加载 SW。

// ---------- 点赞数格式化 ----------
function formatLikes(n) {
  if (!n || n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 100000000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'W';
  return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
}

// ---------- 日期格式化 ----------
function formatDate(ts) {
  if (!ts) return '';
  const date = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (isNaN(date.getTime())) return '';
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}.${d}`;
}

const API_TIMEOUT = 10000;
// 解析两段式窗口（速度优先 + 高清无水印优先）：
// 第一段先跑“高清无水印快源”(第三方 API + 自建 api 池)最多 5 秒（单源上限同此窗口）；
// 拿不到再跑“本地通道”(拦截缓存 / 页面深挖 / FetchHTML)最多 4 秒——走浏览器自身出口，
// 不受服务端数据中心 IP 风控影响。
const PARSE_FAST_HD_MS = 5000;
const PARSE_ORIG_MS = 4000;
// 下载候选“首次无进展”判定：30 秒内没有任何字节进展才取消该候选，随后继续下一候选/重试。
// 只要下载一直在走字节，观察会不断顺延（见 runDownload 的 checkTimeout），不会误杀大文件。
const FIRST_STALL_CHECK_MS = 30000;
// 单个候选走代理时的下载尝试次数：CDN 风控是间歇性的（实测同一签名约 50% 波动），
// 一次失败就换候选会浪费掉本来能成功的候选。每次尝试失败后退避重试。
const PROXY_DL_ATTEMPTS = 3;
// 自建解析后端（Cloudflare Pages 同域部署，国内可达；海外边缘多源轮询 + 页面直抓）
const OWN_PARSE_API = 'https://tiktok-downloader-av8.pages.dev/api/parse';
const OWN_PARSE_TOKEN = 'tdp2026x7kq9mz3vn8clw4r';
// 自建下载代理（服务器带 Cookie+Referer 拉流，直连被拒时的兜底通道）
// 必须带 token：后端 /api/proxy 已改为「鉴权 + IP 限流」，裸调用会被 401 拒绝。
const OWN_PROXY_API = 'https://tiktok-downloader-av8.pages.dev/api/proxy?token=' + OWN_PARSE_TOKEN + '&url=';

// 全局错误捕获：后台脚本在个别浏览器（如豆包）可能因某个 API 缺失/受限而在
// 启动阶段抛错导致“手动解析/自动解析全部无响应”，这里把错误打印到 SW 控制台便于排查
try {
  self.addEventListener('error', (e) => {
    try { console.error('[SW error]', e && (e.message || (e.error && e.error.message) || String(e.error))); } catch (_) {}
  });
  self.addEventListener('unhandledrejection', (e) => {
    try { console.error('[SW unhandledrejection]', e && e.reason); } catch (_) {}
  });
} catch (_) {}

// ---------- 工具函数 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 高频诊断日志开关：
// 只用于「网络拦截回调」——它会对页面加载的每一个媒体请求触发，长时间使用时
// 能刷出成百上千行。默认关闭；排查"拦截没抓到地址"时改为 true 即可。
// 注意：下载链路的日志属于低频且排查必需，不受本开关影响，始终输出。
const VERBOSE_LOG = false;
const vlog = (...args) => { if (VERBOSE_LOG) console.log(...args); };

// 自动关闭的通知（默认 8 秒后自动清除，避免一直留在屏幕上）
function showNotification(options, autoCloseMs = 8000) {
  chrome.notifications.create(options, (id) => {
    if (autoCloseMs > 0) {
      setTimeout(() => chrome.notifications.clear(id).catch(() => {}), autoCloseMs);
    }
  });
}

// externalSignal：外部取消信号（用于「竞速命中后立刻取消其余落败请求」，
// 避免它们继续占满带宽与第三方配额）。与本函数自带的超时 controller 叠加生效。
async function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT, externalSignal = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      // 区分「窗口超时」与「竞速命中后主动取消」：后者不是故障，不应报成超时
      throw new Error(externalSignal && externalSignal.aborted ? '请求已取消' : '请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// ============================================================
//  模块一：浏览器网络请求拦截（SW休眠后从 storage.session 恢复）
// ============================================================
const capturedVideoUrls = new Map(); // tabId -> { videoUrl, hdVideoUrl, capturedAt }

// 已知的媒体 CDN 主机片段。**这只是兜底，不是判定的必要条件**——
// TikTok 的 CDN 主机按区域/边缘轮换（`*-webapp-prime.tiktok.com`（Akamai）、
// `*.tiktokv.com`、`*.tiktokv.eu`、`*.muscdn.com`、`*.tiktokcdn.com` ...），
// 白名单一旦漏项，拦截器会把媒体请求**静默丢弃**，静默标签页必然超时，
// 表现就是"解析不出来"。2026-11-05 即因此修复：原清单只有 tiktokcdn/douyin*，
// 漏掉 prime/tiktokv/muscdn，而这些恰恰是实际播放地址所在。
const CDN_DOMAINS = [
  'tiktokcdn', 'tiktokv.', 'muscdn', 'webapp-prime.tiktok.com',
  'douyinvod', 'douyinpic', 'douyinstatic', 'bytecdntp', 'bytecdn',
  'amemv', 'zjcdn', 'ibytedtos'
];

// 判定是否「视频媒体请求」。
// 首要依据是浏览器给的资源类型（type==='media'），**不看主机名**；
// 主机白名单仅用于 type 不可靠时的兜底，避免再次因 CDN 换域名而全面失效。
function isVideoCdnUrl(url, type) {
  if (!/\.(mp4|m3u8|webm)(\?|$)/i.test(url || '')) return false;
  if (type === 'media') return true;
  return CDN_DOMAINS.some(d => url.includes(d));
}

// 节流写入 storage.session：最多每 1 秒写一次，避免频繁 IO
// （storage.session 为 Chrome 102+/Edge 新增；Firefox 与老内核没有该 API，
//   缺失时仅跳过持久化，不影响拦截功能本身）
let _capturedSaveTimer = null;
function saveCapturedToSession() {
  if (_capturedSaveTimer) return;
  _capturedSaveTimer = setTimeout(() => {
    _capturedSaveTimer = null;
    if (!chrome.storage || !chrome.storage.session) return;
    const obj = {};
    for (const [k, v] of capturedVideoUrls) obj[k] = v;
    chrome.storage.session.set({ capturedVideoUrls: obj }).catch(() => {});
  }, 1000);
}

// SW 启动时从 storage.session 恢复拦截缓存
(async () => {
  try {
    if (!chrome.storage || !chrome.storage.session) return;
    const stored = await chrome.storage.session.get('capturedVideoUrls');
    if (stored.capturedVideoUrls) {
      for (const [tabId, data] of Object.entries(stored.capturedVideoUrls)) {
        capturedVideoUrls.set(Number(tabId), data);
      }
      console.log(`[拦截] 从 session 恢复 ${capturedVideoUrls.size} 条缓存`);
    }
  } catch (e) { console.warn('[拦截] 恢复 session 缓存失败:', e.message); }
})();

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const { tabId, url, type } = details;
    if (tabId < 0 || !isVideoCdnUrl(url, type)) return;

    const existing = capturedVideoUrls.get(tabId) || {};
    // media 类型或 URL 含 hdplay/watermark=0 通常是无水印高清
    const isHd = type === 'media' || /hdplay|watermark=0|bitrate/i.test(url);

    if (isHd || !existing.hdVideoUrl) existing.hdVideoUrl = url;
    if (!existing.videoUrl) existing.videoUrl = url;
    existing.capturedAt = Date.now();
    capturedVideoUrls.set(tabId, existing);
    saveCapturedToSession();

    vlog(`[拦截] tab=${tabId} type=${type} hd=${isHd}`);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  capturedVideoUrls.delete(tabId);
  saveCapturedToSession();
});

// 主动从标签页抓取视频地址（SW 休眠导致 webRequest 没抓到时的补救）
async function preCaptureFromTab(tabId) {
  if (!tabId || tabId < 0) return false;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const urls = [];
        // 从 performance entries 抓
        try {
          const entries = performance.getEntriesByType('resource');
          for (const e of entries) {
            if (!e.name || /^(blob|data|mediasource):/i.test(e.name)) continue;
            // 媒体扩展名 / initiatorType=video 本身就是充分证据，**不再要求主机在白名单内**：
            // TikTok 的媒体 CDN 按区域轮换（*-webapp-prime.tiktok.com、*.tiktokv.eu、
            // *.muscdn.com ...），白名单漏项会让这里整段失效。
            const isMedia = /\.(mp4|m3u8|webm|flv)(\?|$)/i.test(e.name) || e.initiatorType === 'video';
            const isCdnNoExt = (e.name.includes('tiktokcdn') || e.name.includes('tiktokv')
                       || e.name.includes('douyinvod') || e.name.includes('douyinpic')
                       || e.name.includes('bytecdntp') || e.name.includes('bytecdn')
                       || e.name.includes('amemv.com') || e.name.includes('douyin.com')
                       || e.name.includes('muscdn') || e.name.includes('ibytedtos'))
                       && (e.name.includes('video_id') || e.name.includes('play_addr')
                           || e.name.includes('/video/') || e.name.includes('playwm'));
            if (isMedia || isCdnNoExt) urls.push(e.name);
          }
        } catch (e) {}
        // 从 video 标签抓（包括 src、data-src、poster 等属性）
        try {
          const videos = document.querySelectorAll('video');
          for (const v of videos) {
            const candidates = [v.src, v.getAttribute('data-src'), v.currentSrc];
            for (const src of candidates) {
              if (src && !src.startsWith('blob:') && !src.startsWith('mediasource:') && /\.(mp4|m3u8|webm)/i.test(src)) {
                urls.push(src);
              }
            }
          }
        } catch (e) {}
        // 从页面 JSON 里快速提取视频地址（抖音/TikTok 的 RENDER_DATA 等）
        try {
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.length > 50000) continue; // 跳过过大的脚本
            // 匹配 playAddr、hdplay、download_addr 等字段
            const matches = text.match(/"(play_addr|hdplay|download_addr|play_url|video_url)":\s*"([^"]+)"/g);
            if (matches) {
              for (const m of matches) {
                const urlMatch = m.match(/"([^"]+)"\s*$/);
                if (urlMatch && urlMatch[1].startsWith('http')) urls.push(urlMatch[1]);
              }
            }
            // 匹配完整的 mp4 URL
            const urlMatches = text.match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g);
            if (urlMatches) {
              for (const u of urlMatches) {
                if (!u.includes('avatar') && !u.includes('icon')) urls.push(u);
              }
            }
          }
        } catch (e) {}
        return urls;
      }
    });
    const urls = result?.[0]?.result || [];
    if (urls.length > 0) {
      // 去重并选最长的 URL（通常是高清地址）
      const unique = [...new Set(urls)];
      unique.sort((a, b) => b.length - a.length);
      const existing = capturedVideoUrls.get(tabId) || {};
      existing.hdVideoUrl = unique[0];
      existing.videoUrl = unique[0];
      existing.capturedAt = Date.now();
      capturedVideoUrls.set(tabId, existing);
      saveCapturedToSession();
      console.log(`[主动抓取] tab=${tabId} 抓到 ${urls.length} 个视频地址`);
      return true;
    }
  } catch (e) { console.log('[主动抓取] 失败:', e.message); }
  return false;
}

// ============================================================
//  模块二：页面深度解析（6 个数据源）
// ============================================================
// explicitTabId：显式指定要深挖的标签页。静默标签页通道必须用它——那种标签页是
// active:false 的后台页，如果仍去取「当前激活标签页」，会读到用户正在看的另一个页面
// （或被 videoId 校验挡下而永远失败）。不传则维持原行为：取当前激活标签页。
async function parseViaPageDeep(finalUrl, explicitTabId = null) {
  let targetTabId = explicitTabId;
  let tabUrl = '';
  if (targetTabId) {
    const info = await chrome.tabs.get(targetTabId).catch(() => null);
    if (!info) throw new Error('tab not found');
    tabUrl = info.url || '';
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs?.[0]?.id) throw new Error('no tab');
    targetTabId = tabs[0].id;
    tabUrl = tabs[0].url || '';
  }
  // 放宽检查：目标标签页必须是 TikTok/抖音域名
  const isTiktokOrDouyin = /tiktok\.com|douyin\.com/i.test(tabUrl);
  if (!isTiktokOrDouyin) throw new Error('tab not tiktok/douyin');

  // 提取 videoId（支持 /video/{id} 和 /v/{id} 两种格式）
  const getVideoId = (u) => {
    const m = u.match(/\/video\/(\d+)/) || u.match(/\/v\/(\d+)/);
    return m ? m[1] : null;
  };
  const urlId = getVideoId(finalUrl);
  const tabId = getVideoId(tabUrl);

  // 与拦截路径同一规则：请求带了具体 videoId 时，标签页必须指向同一视频，
  // 否则会从「另一个视频」的页面数据里提取地址（推荐页/用户主页尤其明显）。
  if (urlId && urlId !== tabId) throw new Error('tab mismatch');

  let injectTimeoutId;
  const result = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: () => {
        const found = [];

        // 数据源 1: __UNIVERSAL_DATA_FOR_REHYDRATION__（增加更多路径，支持推荐页）
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
                   || document.getElementById('__UNIVERSAL_DATA__');
          if (el) {
            const raw = JSON.parse(el.textContent);
            const data = raw?.__DEFAULT_SCOPE__ || raw;
            // 视频详情页路径
            let v = data?.videoData?.[0] || data?.itemInfo?.itemStruct || data?.itemStruct
                   || data?.['webapp.video-detail']?.itemInfo?.itemStruct
                   || data?.['webapp.video-detail']?.itemStruct;
            // 推荐页路径：从 feed 列表里取第一个
            if (!v) {
              const feed = data?.['webapp.feed'] || data?.feed || data?.HomeFeed;
              if (feed) {
                const feedItems = feed?.itemList || feed?.videos || feed?.data;
                if (Array.isArray(feedItems) && feedItems.length > 0) {
                  v = feedItems[0]?.itemStruct || feedItems[0];
                }
              }
            }
            if (v) found.push({ source: 'universal', data: v });
          }
        } catch (e) {}

        // 数据源 2: SIGI_STATE（首页取当前播放视频，取不到则取第一个）
        try {
          const el = document.getElementById('SIGI_STATE');
          if (el) {
            const data = JSON.parse(el.textContent);
            const itemModule = data?.ItemModule;
            if (itemModule) {
              const ids = Object.keys(itemModule);
              if (ids.length > 0) {
                // 方式1：从 video 元素向上找容器提取视频ID
                let currentId = null;
                try {
                  const videoEl = document.querySelector('video');
                  if (videoEl) {
                    let container = videoEl.closest('[data-e2e="feed-item"]') 
                                  || videoEl.closest('[class*="DivItemContainer"]')
                                  || videoEl.closest('a[href*="/video/"]')
                                  || videoEl.closest('[class*="ItemContainer"]')
                                  || videoEl.parentElement?.parentElement?.parentElement;
                    if (container) {
                      const href = container.querySelector('a[href*="/video/"]')?.href 
                                || container.getAttribute('href') || '';
                      const idMatch = href.match(/\/video\/(\d+)/);
                      if (idMatch && itemModule[idMatch[1]]) currentId = idMatch[1];
                    }
                  }
                } catch (e) {}
                
                // 方式2：从页面所有 /video/ 链接中，找到在视口中的那个
                if (!currentId) {
                  try {
                    const links = document.querySelectorAll('a[href*="/video/"]');
                    for (const link of links) {
                      const rect = link.getBoundingClientRect();
                      // 在视口范围内（上下各留一点余量）
                      if (rect.top >= -100 && rect.bottom <= window.innerHeight + 100) {
                        const idMatch = link.href.match(/\/video\/(\d+)/);
                        if (idMatch && itemModule[idMatch[1]]) {
                          currentId = idMatch[1];
                          break;
                        }
                      }
                    }
                  } catch (e) {}
                }
                
                // 方式3：从 SIGI_STATE 的 FeedModule 或其他字段找当前视频ID
                if (!currentId) {
                  try {
                    const feed = data?.FeedModule || data?.feed || data?.HomeFeed;
                    if (feed) {
                      const feedIds = Object.keys(feed);
                      if (feedIds.length > 0) {
                        const firstFeed = feed[feedIds[0]];
                        const feedItemId = firstFeed?.id || firstFeed?.itemId || firstFeed?.videoId;
                        if (feedItemId && itemModule[feedItemId]) currentId = feedItemId;
                      }
                    }
                  } catch (e) {}
                }
                
                // 如果没找到当前播放的，取第一个
                const targetId = currentId && itemModule[currentId] ? currentId : ids[0];
                found.push({ source: 'sigi', data: itemModule[targetId] });
              }
            }
          }
        } catch (e) {}

        // 数据源 3: window 全局变量（增加更多可能的变量名）
        try {
          const w = window;
          const item = w.__INITIAL_STATE__?.itemInfo?.itemStruct
                    || w.__NEXT_DATA__?.props?.pageProps?.itemInfo?.itemStruct
                    || w._SSR_HYDRATED_DATA__?.itemInfo?.itemStruct
                    || w.__INITIAL_STATE__?.itemStruct
                    || w._SSR_HYDRATED_DATA__?.itemStruct;
          if (item) found.push({ source: 'window', data: item });
        } catch (e) {}

        // 数据源 4: <video> 标签 src（支持 mp4 和 m3u8，blob URL 跳过）
        try {
          const videoEls = document.querySelectorAll('video');
          for (const v of videoEls) {
            if (v.src && !v.src.startsWith('blob:') && /\.(mp4|m3u8)(\?|$)/i.test(v.src)) {
              found.push({ source: 'video_tag', data: { playAddr: v.src, hdplay: v.src } });
              break;
            }
          }
        } catch (e) {}

        // 数据源 4.5: <source> 标签
        try {
          const sourceEls = document.querySelectorAll('source');
          for (const s of sourceEls) {
            if (s.src && /\.(mp4|m3u8)(\?|$)/i.test(s.src)) {
              found.push({ source: 'source_tag', data: { playAddr: s.src, hdplay: s.src } });
              break;
            }
          }
        } catch (e) {}

        // 数据源 5: performance API
        // 媒体扩展名 / initiatorType=video / contentType=video 即为充分证据，
        // **不再要求主机在白名单内**——CDN 会按区域轮换，白名单漏项会让本数据源整段失效。
        try {
          const entries = performance.getEntriesByType('resource')
            .filter(e => {
              if (!e.name || /^(blob|data|mediasource):/i.test(e.name)) return false;
              const isVideo = /\.(mp4|m3u8|webm)(\?|$)/i.test(e.name)
                           || e.initiatorType === 'video' || e.contentType?.includes('video');
              if (!isVideo) return false;
              // 排除纯音频、以及明显的静态资源域名
              if (/\.(mp3|m4a|aac)(\?|$)/i.test(e.name)) return false;
              return true;
            });
          if (entries.length > 0) {
            entries.sort((a, b) => (b.transferSize || b.encodedBodySize || b.duration || 0)
                                  - (a.transferSize || a.encodedBodySize || a.duration || 0));
            found.push({
              source: 'performance',
              data: { playAddr: entries[0].name, hdplay: entries[0].name }
            });
          }
        } catch (e) {}

        // 数据源 6: <script> 文本中正则搜视频地址（支持 mp4/m3u8/playAddr/hdplay）
        try {
          const scripts = document.querySelectorAll('script:not([src])');
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.length > 100000) continue;
            // 搜完整 URL
            const urlMatches = text.match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g);
            if (urlMatches?.length > 0) {
              urlMatches.sort((a, b) => b.length - a.length);
              found.push({ source: 'script_regex', data: { playAddr: urlMatches[0], hdplay: urlMatches[0] } });
              break;
            }
            // 搜 playAddr/hdplay/downloadAddr 字段
            const fieldMatch = text.match(/"(playAddr|hdplay|downloadAddr)"\s*:\s*"([^"]+)"/);
            if (fieldMatch) {
              const url = fieldMatch[2].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
              found.push({ source: 'script_field', data: { playAddr: url, hdplay: url } });
              break;
            }
          }
        } catch (e) {}

        // 额外：提取页面元数据（标题、作者）
        let meta = {};
        try {
          meta.title = document.querySelector('meta[property="og:title"]')?.content
                    || document.querySelector('h1')?.textContent?.trim()
                    || '';
          meta.author = document.querySelector('meta[property="og:description"]')?.content?.match(/@(\w+)/)?.[1]
                     || document.querySelector('[data-e2e="browse-username"]')?.textContent?.trim()
                     || '';
          meta.cover = document.querySelector('meta[property="og:image"]')?.content || '';
        } catch (e) {}

        return { found, meta };
      }
    }).finally(() => clearTimeout(injectTimeoutId)),
    new Promise((_, reject) => {
      injectTimeoutId = setTimeout(() => reject(new Error('注入超时')), 4000);
    })
  ]);

  if (!result?.[0]?.result) throw new Error('注入无返回');

  const { found, meta } = result[0].result;
  if (!found || found.length === 0) throw new Error('页面无视频数据');

  // 按数据源优先级排序
  const priority = { universal: 0, sigi: 1, window: 2, video_tag: 3, source_tag: 4, performance: 5, script_field: 6, script_regex: 7 };
  found.sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9));

  // 用最高优先级的数据源解析
  for (const item of found) {
    const info = await extractVideoInfo(item.data, finalUrl);
    if (info?.success) {
      // 与 parseViaFetchHtml 同一口径：质量以实际取到的地址为准，只有判不出来时才
      // 退回按来源估计。原实现无条件按来源覆写，而 universal/sigi 优先级最高、
      // 页面又必然含这些数据块 → 几乎所有结果都被误标「原画质」（2026-09-17 排查）。
      info.quality = info.quality
        || (item.source === 'universal' || item.source === 'sigi' ? '原画质' : '高清');
      info._parseSource = item.source;
      // 补充页面元数据
      if (!info.title || info.title === '无标题') info.title = meta.title || info.title;
      if (!info.author || info.author === '未知作者') info.author = meta.author || info.author;
      if (!info.cover) info.cover = meta.cover || info.cover;
      return info;
    }
  }

  throw new Error('深度解析失败');
}

// ============================================================
//  模块二点五：Fetch HTML 解析（粘贴链接时也能不走 API）
// ============================================================
async function parseViaFetchHtml(finalUrl, signal = null) {
  // 只处理 TikTok/抖音的标准视频链接，短链接已经在前面展开了
  if (!/tiktok\.com|douyin\.com/i.test(finalUrl)) throw new Error('not tiktok/douyin url');

  let html;
  try {
    const resp = await fetchWithTimeout(finalUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, 6000, signal);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error('fetch 页面失败: ' + e.message);
  }

  if (!html || html.length < 1000) throw new Error('HTML 内容过短');

  // 尝试从 HTML 中提取 JSON 数据
  const found = [];

  // 数据源 1: __UNIVERSAL_DATA_FOR_REHYDRATION__
  try {
    const match = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      const raw = JSON.parse(match[1]);
      const data = raw?.__DEFAULT_SCOPE__ || raw;
      const v = data?.videoData?.[0] || data?.itemInfo?.itemStruct || data?.itemStruct
             || data?.['webapp.video-detail']?.itemInfo?.itemStruct
             || data?.['webapp.video-detail']?.itemStruct;
      if (v) found.push({ source: 'fetch_universal', data: v });
    }
  } catch (e) {}

  // 数据源 2: SIGI_STATE
  try {
    const match = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      const itemModule = data?.ItemModule;
      if (itemModule) {
        const ids = Object.keys(itemModule);
        if (ids.length > 0) found.push({ source: 'fetch_sigi', data: itemModule[ids[0]] });
      }
    }
  } catch (e) {}

  // 数据源 3: __NEXT_DATA__
  try {
    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      const v = data?.props?.pageProps?.itemInfo?.itemStruct;
      if (v) found.push({ source: 'fetch_next', data: v });
    }
  } catch (e) {}

  // 数据源 4: 正则搜 playAddr/hdplay/downloadAddr 字段
  try {
    const fieldMatch = html.match(/"(playAddr|hdplay|downloadAddr)"\s*:\s*"([^"]{20,})"/);
    if (fieldMatch) {
      const url = fieldMatch[2].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      if (url.startsWith('http')) {
        found.push({ source: 'fetch_field', data: { playAddr: url, hdplay: url } });
      }
    }
  } catch (e) {}

  // 数据源 5: 正则搜完整 mp4/m3u8 URL
  try {
    const urlMatches = html.match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g);
    if (urlMatches?.length > 0) {
      // 过滤掉明显不是视频的 URL（如图标）
      const valid = urlMatches.filter(u => u.length > 50 && !u.includes('avatar') && !u.includes('icon'));
      if (valid.length > 0) {
        valid.sort((a, b) => b.length - a.length);
        found.push({ source: 'fetch_regex', data: { playAddr: valid[0], hdplay: valid[0] } });
      }
    }
  } catch (e) {}

  if (found.length === 0) throw new Error('HTML 中无视频数据');

  // 按优先级排序
  const priority = { fetch_universal: 0, fetch_sigi: 1, fetch_next: 2, fetch_field: 3, fetch_regex: 4 };
  found.sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9));

  // 提取页面元数据
  let meta = {};
  try {
    const titleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/);
    const descMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/);
    const coverMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/);
    meta.title = titleMatch?.[1] || '';
    meta.author = descMatch?.[1]?.match(/@(\w+)/)?.[1] || '';
    meta.cover = coverMatch?.[1] || '';
  } catch (e) {}

  // 用最高优先级的数据源解析
  for (const item of found) {
    const info = await extractVideoInfo(item.data, finalUrl);
    if (info?.success) {
      // 质量以「实际取到的地址」为准（extractVideoInfo 已判定），
      // 只有它没判出来时才退回按数据来源估计：
      //   __UNIVERSAL_DATA__/SIGI_STATE 里的 playAddr 属于原画质页内地址；
      //   __NEXT_DATA__ / 正则兜底命中的通常是 bitrate/下载地址，按高清算。
      // 原实现是无条件按来源覆写，导致页面必然含 __UNIVERSAL_DATA__ →
      // 几乎所有视频都被误标「原画质」（2026-09-17 排查确认）。
      info.quality = info.quality
        || (item.source === 'fetch_universal' || item.source === 'fetch_sigi' ? '原画质' : '高清');
      info._parseSource = item.source;
      if (!info.title || info.title === '无标题') info.title = meta.title || info.title;
      if (!info.author || info.author === '未知作者') info.author = meta.author || info.author;
      if (!info.cover) info.cover = meta.cover || info.cover;
      return info;
    }
  }
  throw new Error('Fetch HTML 解析失败');
}

// ---------- 提取视频信息（兼容多字段） ----------
async function extractVideoInfo(videoData, url) {
  if (!videoData) return null;
  const video = videoData.video || videoData.videoData || videoData;
  const author = videoData.author || videoData.authorInfo || videoData.authorMeta || {};

  let videoUrl = '', hdVideoUrl = '';
  // 质量由「实际取到了什么地址」决定，而不是由调用方按数据来源贴标签。
  // 背景（2026-09-17 排查）：原实现里 parseViaFetchHtml 仅凭数据来自
  // __UNIVERSAL_DATA__/SIGI_STATE 就贴「原画质」，于是几乎所有 TikTok 视频
  // （页面必然含 __UNIVERSAL_DATA__）都被标成原画质，标签完全失真。
  // 实际上 bitrateInfo 里的最高码率 PlayAddr 本身就是高清地址。
  let qualityHint = '';

  // 1. bitrateInfo 最高码率 —— 这是明确的高清来源
  if (video.bitrateInfo && Array.isArray(video.bitrateInfo) && video.bitrateInfo.length > 0) {
    const sorted = [...video.bitrateInfo].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = sorted[0];
    let addr = '';
    if (best?.PlayAddr?.UrlList?.length) addr = best.PlayAddr.UrlList[0];
    else if (best?.playAddr?.urlList?.length) addr = best.playAddr.urlList[0];
    else if (best?.UrlList?.length) addr = best.UrlList[0];
    else if (best?.urlList?.length) addr = best.urlList[0];
    else if (best?.url) addr = best.url;
    if (addr?.startsWith('http')) { videoUrl = addr.trim(); hdVideoUrl = addr.trim(); qualityHint = '高清'; }
  }

  // 2. downloadAddr（官方无水印下载地址，同样是高清级）
  if (!videoUrl && video.downloadAddr) {
    let addr = '';
    if (typeof video.downloadAddr === 'string') addr = video.downloadAddr;
    else if (video.downloadAddr.urlList?.length) addr = video.downloadAddr.urlList[0];
    else if (video.downloadAddr.UrlList?.length) addr = video.downloadAddr.UrlList[0];
    if (addr?.startsWith('http')) { videoUrl = addr.trim(); hdVideoUrl = addr.trim(); qualityHint = '高清'; }
  }

  // 3. 多字段遍历
  if (!videoUrl) {
    const fields = ['hdplay', 'playAddr', 'play', 'play_url', 'src', 'video_url', 'url'];
    // 记住命中的字段名：hdplay/playAddr 是官方高清字段，用于质量判定
    let hitField = '';
    for (const field of fields) {
      const val = video[field];
      if (!val) continue;
      if (typeof val === 'string' && val.startsWith('http')) {
        videoUrl = val.trim();
        if (field === 'hdplay' || field === 'playAddr') hdVideoUrl = val.trim();
        hitField = field;
        break;
      }
      if (Array.isArray(val) && val.length) {
        const first = val[0];
        if (typeof first === 'string' && first.startsWith('http')) {
          videoUrl = first.trim();
          if (field === 'hdplay') hdVideoUrl = first.trim();
          hitField = field;
          break;
        }
        if (first?.url?.startsWith('http')) {
          videoUrl = first.url.trim();
          if (field === 'hdplay') hdVideoUrl = first.url.trim();
          hitField = field;
          break;
        }
      }
      if (val.urlList?.length) {
        const first = val.urlList[0];
        if (first?.startsWith('http')) { videoUrl = first.trim(); if (field === 'hdplay') hdVideoUrl = first.trim(); hitField = field; break; }
      }
      if (val.UrlList?.length) {
        const first = val.UrlList[0];
        if (first?.startsWith('http')) { videoUrl = first.trim(); if (field === 'hdplay') hdVideoUrl = first.trim(); hitField = field; break; }
      }
    }
    if (videoUrl && (hitField === 'hdplay' || hitField === 'playAddr')) qualityHint = '高清';
  }

  // 4. 正则兜底（支持 mp4 和 m3u8）
  if (!videoUrl) {
    const matches = JSON.stringify(videoData).match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g);
    if (matches?.length) {
      matches.sort((a, b) => b.length - a.length);
      videoUrl = matches[0].trim();
      hdVideoUrl = videoUrl;
    }
  }

  if (!videoUrl) return null;
  if (!hdVideoUrl) hdVideoUrl = videoUrl;

  const title = videoData.desc || videoData.description || videoData.title || '无标题';
  const rawLikes = video.digg_count || video.diggCount || video.statistics?.digg_count
    || video.stats?.diggCount || videoData.statistics?.digg_count || videoData.stats?.diggCount || 0;
  const rawCreateTime = video.create_time || video.createTime || videoData.create_time || videoData.createTime || 0;

  return {
    success: true,
    originalUrl: url,
    id: video.id || video.vid || video.awemeId || Date.now(),
    title,
    author: author.nickname || author.uniqueId || author.name || '未知作者',
    authorAvatar: author.avatarThumb || author.avatarLarger || author.avatar || '',
    cover: video.originCover || video.origin_cover || video.cover || '',
    videoUrl,
    hdVideoUrl,
    duration: video.duration || video.videoDuration || 0,
    // 取到了明确的最高码率/无水印下载地址即视为高清；否则交由调用方按来源判定。
    // 不要把 '原画质' 写死在这里：那是"来源"语义，会让所有调用方都拿到错误的默认值。
    quality: qualityHint,
    language: '',
    likes: formatLikes(rawLikes),
    createTime: formatDate(rawCreateTime)
  };
}

// ============================================================
//  模块三：语言检测 + 评论（异步补充）
// ============================================================
async function detectLanguage(text) {
  if (!text || text.trim().length < 2) return '未知语言';
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.i18n.detectLanguage(text, (r) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r);
      });
    });
    if (result?.languages?.length) {
      const top = result.languages[0];
      if (top.percentage > 50) {
        const langMap = {
          'en': '英语', 'id': '印尼语', 'ms': '马来语', 'fr': '法语', 'de': '德语',
          'es': '西班牙语', 'pt': '葡萄牙语', 'it': '意大利语', 'nl': '荷兰语',
          'ru': '俄语', 'ja': '日语', 'ko': '韩语', 'zh': '中文', 'zh-CN': '中文（简体）',
          'zh-TW': '中文（繁体）', 'th': '泰语', 'vi': '越南语', 'ar': '阿拉伯语',
          'hi': '印地语', 'tr': '土耳其语', 'pl': '波兰语', 'uk': '乌克兰语',
          'el': '希腊语', 'he': '希伯来语', 'tl': '菲律宾语', 'sw': '斯瓦希里语',
          'jw': '爪哇语', 'su': '巽他语', 'ne': '尼泊尔语', 'ta': '泰米尔语',
          'te': '泰卢固语', 'mr': '马拉地语', 'ur': '乌尔都语', 'fa': '波斯语',
          'ps': '普什图语', 'ku': '库尔德语', 'am': '阿姆哈拉语', 'so': '索马里语',
          'ha': '豪萨语', 'yo': '约鲁巴语', 'ig': '伊博语', 'zu': '祖鲁语',
          'af': '南非荷兰语', 'ca': '加泰罗尼亚语', 'cs': '捷克语', 'da': '丹麦语',
          'et': '爱沙尼亚语', 'fi': '芬兰语', 'hu': '匈牙利语', 'is': '冰岛语',
          'lt': '立陶宛语', 'lv': '拉脱维亚语', 'no': '挪威语', 'ro': '罗马尼亚语',
          'sk': '斯洛伐克语', 'sl': '斯洛文尼亚语', 'sv': '瑞典语'
        };
        return langMap[top.language] || '未知语言';
      }
    }
  } catch (e) { console.warn('语言检测失败:', e); }

  if (/[\u4e00-\u9fff]/.test(text)) return '中文';
  if (/[\u3040-\u30ff]/.test(text)) return '日文';
  if (/[\uac00-\ud7af]/.test(text)) return '韩文';
  if (/[\u0e00-\u0e7f]/.test(text)) return '泰文';
  if (/[\u0400-\u04ff]/.test(text)) return '俄语/西里尔文';
  if (/[a-zA-Z]/.test(text)) return '拉丁语系（未识别）';
  return '未知语言';
}

async function fetchComments(videoId, limit = 15) {
  if (!videoId) return [];
  try {
    const resp = await fetchWithTimeout(
      `https://api.tikwm.com/api/comment/list?video_id=${videoId}&count=${limit}`, {}, 5000
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data.code === 0 && data.data?.comments) {
      return data.data.comments.map(c => c.text || '').filter(t => t.trim().length > 0);
    }
  } catch (e) { console.warn('[评论] 获取失败:', e.message); }
  return [];
}

// 异步补充串行队列：防止多个视频同时写缓存互相覆盖
let _enrichQueue = Promise.resolve();
async function enrichVideoAsync(video) {
  _enrichQueue = _enrichQueue.then(async () => {
    try {
      const comments = await fetchComments(video.id, 15);
      const textForLang = comments.join(' ').length > 20 ? comments.join(' ') : video.title;
      video.language = await detectLanguage(textForLang);
      // 走统一写入口：与解析入列、文件大小回填串行化，避免整表互相覆盖
      await mutateCachedVideos((all) => {
        const idx = all.findIndex(v => v.id === String(video.id));
        if (idx === -1) return null;
        all[idx].language = video.language;
        return all;
      });
    } catch (e) { console.warn('[异步补充] 失败:', e.message); }
  });
  return _enrichQueue;
}

// ============================================================
//  模块四：第三方 API（兜底）
// ============================================================

// 通用解析：douyin.wtf / qingdou 等 “hybrid/video_data” 风格抖音接口（code 200 + data.video_data）
function parseHybridDouyin(data) {
  if (!data || data.code !== 200 || !data.data) return null;
  const vd = data.data.video_data || data.data;
  const author = data.data.author || vd.author || {};
  const play = String(vd.play || vd.play_addr || vd.video_url || '').trim();
  const images = Array.isArray(vd.images)
    ? vd.images.map(x => {
        if (typeof x === 'string') return x;
        if (x && x.url_list && Array.isArray(x.url_list)) return x.url_list[0] || '';
        return (x && x.url) || '';
      }).filter(Boolean)
    : [];
  if (!play && !images.length) return null;
  return {
    success: true, type: (images.length && !play) ? 'photo' : 'video',
    id: vd.vid || vd.aweme_id || vd.id || Date.now(), title: vd.desc || vd.title || '无标题',
    author: author.nickname || '未知作者', authorAvatar: author.avatar || '',
    cover: vd.cover || '', videoUrl: play,
    hdVideoUrl: String(vd.hdplay || vd.hd_play || vd.no_watermark || play).trim(),
    images, duration: vd.duration || 0, quality: '高清',
    likes: formatLikes(vd.statistics?.digg_count || vd.digg_count || vd.stats?.diggCount || 0),
    createTime: formatDate(vd.create_time || vd.createTime || 0)
  };
}

function getApiList(encoded) {
  return [
    {
      url: `https://api.tikwm.com/api/?url=${encoded}&hd=1`,
      parse: (data) => {
        if (data.code === 0 && data.data) {
          const d = data.data;
          return {
            success: true, id: d.id || Date.now(), title: d.title || '无标题',
            author: d.author?.nickname || '未知作者', authorAvatar: d.author?.avatar || '',
            cover: d.cover || '', videoUrl: (d.play || '').trim(),
            hdVideoUrl: (d.hdplay || d.play || '').trim(), duration: d.duration || 0, quality: '高清',
            likes: formatLikes(d.digg_count || d.statistics?.digg_count || 0),
            createTime: formatDate(d.create_time || d.createTime || 0)
          };
        }
        return null;
      }
    },
    {
      url: `https://www.tikwm.com/api/?url=${encoded}&hd=1`,
      parse: (data) => {
        if (data.code === 0 && data.data) {
          const d = data.data;
          return {
            success: true, id: d.id || Date.now(), title: d.title || '无标题',
            author: d.author?.nickname || '未知作者', authorAvatar: d.author?.avatar || '',
            cover: d.cover || '', videoUrl: (d.play || '').trim(),
            hdVideoUrl: (d.hdplay || d.play || '').trim(), duration: d.duration || 0, quality: '高清',
            likes: formatLikes(d.digg_count || d.statistics?.digg_count || 0),
            createTime: formatDate(d.create_time || d.createTime || 0)
          };
        }
        return null;
      }
    },
    {
      url: `https://api.douyin.wtf/api/hybrid/video_data?url=${encoded}&minimal=false`,
      parse: parseHybridDouyin
    },
    {
      url: `https://www.douyin.wtf/api/hybrid/video_data?url=${encoded}&minimal=false`,
      parse: parseHybridDouyin
    },
    {
      url: `https://api.qingdou.vip/api/hybrid/video_data?url=${encoded}&minimal=false`,
      parse: parseHybridDouyin
    },
    {
      url: `https://api-social-sooty.vercel.app/api/tiktok?url=${encoded}`,
      parse: (data) => {
        if (data.status === 'success' && data.data) {
          const d = data.data;
          const v = d.video || {};
          return {
            success: true, id: d.id || Date.now(), title: d.title || '无标题',
            author: d.author?.nickname || d.author?.username || '未知作者',
            authorAvatar: d.author?.avatar || '', cover: v.cover || '',
            videoUrl: (v.download_url || '').trim(),
            hdVideoUrl: (v.no_watermark_url || v.download_url || '').trim(),
            duration: v.duration || 0, quality: '高清',
            likes: formatLikes(d.stats?.likes || 0), createTime: ''
          };
        }
        return null;
      }
    },
    {
      url: `https://api.tiklydown.eu.org/api/download?url=${encoded}`,
      parse: (data) => {
        if (data?.status === 'success' || data?.code === 200) {
          const d = data.data || data.result || data;
          const video = d.video || d;
          const author = d.author || d.authorInfo || {};
          const playUrl = video.play || video.noWatermark || video.url || video.hdplay || '';
          if (playUrl) {
            return {
              success: true, id: d.id || d.video_id || d.aweme_id || Date.now(),
              title: d.title || d.desc || d.description || '无标题',
              author: author.nickname || author.unique_id || author.name || '未知作者',
              authorAvatar: author.avatar || author.avatar_larger || '',
              cover: d.cover || video.cover || video.origin_cover || '',
              videoUrl: playUrl.trim(),
              hdVideoUrl: (video.hdplay || video.noWatermark || playUrl || '').trim(),
              duration: video.duration || d.duration || 0, quality: '高清',
              likes: formatLikes(d.digg_count || d.likes || d.statistics?.digg_count || 0),
              createTime: formatDate(d.create_time || d.created_at || 0)
            };
          }
        }
        return null;
      }
    },
    {
      url: `https://api.tikmate.app/api/v1/fetch?url=${encoded}`,
      parse: (data) => {
        if (data?.success && data.data) {
          const d = data.data;
          return {
            success: true, id: d.id || d.video_id || Date.now(), title: d.title || d.description || '无标题',
            author: d.author?.nickname || d.author_name || '未知作者',
            authorAvatar: d.author?.avatar || d.author_avatar || '',
            cover: d.cover || d.thumbnail || '',
            videoUrl: (d.play || d.video_url || '').trim(),
            hdVideoUrl: (d.hdplay || d.hd_video_url || d.play || d.video_url || '').trim(),
            duration: d.duration || 0, quality: '高清',
            likes: formatLikes(d.digg_count || d.likes || d.stats?.digg_count || 0),
            createTime: formatDate(d.create_time || d.created_at || 0)
          };
        }
        return null;
      }
    },
    {
      url: `https://api.douyin.wtf/api/download?url=${encoded}`,
      parse: (data) => {
        if (data?.code === 200 || data?.status === 'success') {
          const d = data.data || data.result || data;
          const video = d.video || d;
          const playUrl = video.play || video.play_addr || video.url || video.download_url || '';
          if (playUrl) {
            return {
              success: true, id: d.aweme_id || d.vid || d.id || Date.now(),
              title: d.desc || d.title || d.description || '无标题',
              author: d.author?.nickname || d.nickname || '未知作者',
              authorAvatar: d.author?.avatar || d.avatar || '',
              cover: d.cover || video.cover || '',
              videoUrl: playUrl.trim(),
              hdVideoUrl: (video.hdplay || video.play_hd || playUrl || '').trim(),
              duration: video.duration || d.duration || 0, quality: '高清',
              likes: formatLikes(d.statistics?.digg_count || d.digg_count || 0),
              createTime: formatDate(d.create_time || d.created_at || 0)
            };
          }
        }
        return null;
      }
    },
    // TikTok-Downloader-API (Cloudflare Workers 公共实例)
    {
      url: `https://tdownv4.sl-bjs.workers.dev/?down=${encoded}`,
      parse: (data) => {
        if (data?.download_url) {
          return {
            success: true, id: data.video_id || Date.now(),
            title: data.title || '无标题',
            author: data.author?.nickname || data.author?.username || '未知作者',
            authorAvatar: data.author?.avatar || '',
            cover: data.cover || '',
            videoUrl: data.download_url.trim(),
            hdVideoUrl: data.download_url.trim(),
            duration: data.author?.duration || data.duration || 0,
            quality: '高清',
            likes: formatLikes(data.author?.like_count || 0),
            createTime: ''
          };
        }
        return null;
      }
    },
    // tikwm 备用域名
    {
      url: `https://api.tikwm.one/api/?url=${encoded}&hd=1`,
      parse: (data) => {
        if (data?.code === 0 && data?.data?.play) {
          const d = data.data;
          return {
            success: true, id: d.id || Date.now(),
            title: d.title || '无标题',
            author: d.author?.nickname || d.author?.unique_id || '未知作者',
            authorAvatar: d.author?.avatar || '',
            cover: d.cover || '',
            videoUrl: (d.play || '').trim(),
            hdVideoUrl: (d.hdplay || d.play || '').trim(),
            duration: d.duration || 0, quality: '高清',
            likes: formatLikes(d.digg_count || 0),
            createTime: formatDate(d.create_time || 0)
          };
        }
        return null;
      }
    },
    // TikDown 风格 API
    {
      url: `https://api.tiklydown.top/api/v3/download?url=${encoded}`,
      parse: (data) => {
        if (data?.code === 0 && data?.data) {
          const d = data.data;
          const video = d.video || {};
          return {
            success: true, id: d.id || Date.now(),
            title: d.description || '无标题',
            author: d.author?.nickname || d.author?.unique_id || '未知作者',
            authorAvatar: d.author?.avatar || '',
            cover: d.covers?.origin || d.cover || '',
            videoUrl: (video.play || '').trim(),
            hdVideoUrl: (video.play || video.wm || '').trim(),
            duration: video.duration || 0, quality: '高清',
            likes: formatLikes(d.stats?.diggCount || 0),
            createTime: formatDate(d.createTime || 0)
          };
        }
        return null;
      }
    },
    // ===== 用户自定义 API 区域 =====
    // 部署好自己的 API 后，取消下面的注释并修改 URL
    // {
    //   url: `https://your-domain.com/api/hybrid/video_data?url=${encoded}&minimal=false`,
    //   parse: parseHybridDouyin
    // }
  ];
}

// ============================================================
//  API 熔断机制：同一 API 主机连续失败3次后冷却5分钟，避免每次都等超时
// 关键：key 必须是「API 身份」（主机名）。若用完整 URL（内含被解析的视频链接），
// 每个视频都会生成一个全新 key，熔断将永远不会触发。
// ============================================================
const apiFailureCount = new Map();   // apiHost -> 连续失败次数
const apiCooldownUntil = new Map();  // apiHost -> 冷却结束时间戳
const API_MAX_FAILURE = 3;
const API_COOLDOWN_MS = 5 * 60 * 1000; // 5分钟

// 从 API 请求 URL 提取稳定的熔断 key（主机名）
function apiKey(apiUrl) {
  try {
    const u = new URL(apiUrl);
    // 带 fragment 时并入 key：自建后端同一主机上有多个用途不同的 mode
    // （api 走解析第一段，html/item 服务下载前取新签名），必须分开熔断，
    // 否则 api 全灭会把 html/item 一起拖进冷却，下载取签名跟着失效。
    return u.hostname + (u.hash || '');
  } catch (e) { return String(apiUrl || '').slice(0, 80); }
}

function isApiInCooldown(apiUrl) {
  const key = apiKey(apiUrl);
  const until = apiCooldownUntil.get(key);
  if (until && Date.now() < until) return true;
  if (until) {
    // 冷却结束，重置
    apiCooldownUntil.delete(key);
    apiFailureCount.set(key, 0);
  }
  return false;
}

function recordApiSuccess(apiUrl) {
  const key = apiKey(apiUrl);
  apiFailureCount.set(key, 0);
  apiCooldownUntil.delete(key);
}

function recordApiFailure(apiUrl) {
  const key = apiKey(apiUrl);
  const count = (apiFailureCount.get(key) || 0) + 1;
  apiFailureCount.set(key, count);
  if (count >= API_MAX_FAILURE) {
    apiCooldownUntil.set(key, Date.now() + API_COOLDOWN_MS);
    console.warn(`[熔断] API ${key} 连续失败${count}次，冷却5分钟`);
  }
}

async function fetchAndParse(apiDef, timeoutMs = PARSE_FAST_HD_MS, signal = null) {
  const apiUrl = apiDef.url;
  try {
    // 单源上限与第一段窗口对齐（5s）：本函数只在第一段并行竞速里调用，竞速整体封顶同为 PARSE_FAST_HD_MS，不累加等待
    const resp = await fetchWithTimeout(apiUrl, {}, timeoutMs, signal);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const result = apiDef.parse(data);
    if (!result || !result.success) throw new Error('解析失败');
    recordApiSuccess(apiUrl);
    return result;
  } catch (e) {
    recordApiFailure(apiUrl);
    throw e;
  }
}

// ============================================================
//  模块五：解析主入口（四级降级）
// ============================================================
// 本地拦截+主动抓取（抽成独立函数，用于并行调用）
// 带3秒超时，快速失败不阻塞其他源
//
// 重要：拦截缓存是「按 tabId」存的，并不记录视频身份。若不加校验，用户粘贴 A 视频
// 链接时会把当前标签页正在播放的 B 视频地址当作解析结果返回（下载到错误视频）。
// 因此：请求里带了具体 videoId 时，标签页必须指向同一个视频；
//       请求里本身没有 videoId（如推荐页/首页的“当前页”）才允许使用拦截结果。
async function parseViaIntercept(finalUrl) {
  return Promise.race([
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tabs?.[0]?.id) throw new Error('no tab');
      const urlId = extractVideoIdFromUrl(finalUrl);
      const tabId = extractVideoIdFromUrl(tabs[0].url || '');
      if (urlId && urlId !== tabId) throw new Error('intercept video id mismatch');
      let captured = capturedVideoUrls.get(tabs[0].id);
      // 只有已拦截到才用，没拦截到不等待主动抓取（太慢）
      if (!captured?.hdVideoUrl) throw new Error('no intercepted url');
      const meta = await extractPageMeta(tabs[0].id);
      return {
        success: true,
        originalUrl: finalUrl,
        id: extractVideoIdFromUrl(finalUrl) || Date.now(),
        title: meta.title || '无标题',
        author: meta.author || '未知作者',
        authorAvatar: '',
        cover: meta.cover || '',
        videoUrl: captured.videoUrl || captured.hdVideoUrl,
        hdVideoUrl: captured.hdVideoUrl,
        duration: 0,
        quality: '原画质',
        language: '',
        likes: '',
        createTime: '',
        _parseSource: 'intercept'
      };
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('intercept timeout')), 3000))
  ]);
}

// ============================================================
//  模块二点二：静默标签页抓取（服务端源失效后的主力通道）
// ============================================================
// 背景（2026-09-17 实测）：自建后端的页面直抓被 TikTok 以 HTTP 403 拒绝（CF 数据中心 IP
// 全段被风控），官方 item 接口返回空结构——服务端已拿不到任何原画质地址。
// 而浏览器本地通道是好的：TikTok 页面 HTML 里内嵌的 __UNIVERSAL_DATA_FOR_REHYDRATION__
// 就含 playAddr（原画质无水印），走用户自己的出口 IP 与登录态，不受服务端风控影响。
//
// 因此：批量解析时若当前没有可用的拦截缓存，就静默开一个后台标签页把视频页加载一遍，
// 由既有的 webRequest 拦截器抓下 CDN 地址，拿到后立即关闭标签页。
//   优点：产出率与"手动打开视频页面"等价，是当前唯一能稳定出原画质的方式。
//   代价：每个视频约 1~2 秒页面加载时间（远优于为死源白等 4~9 秒且零产出）。
//
// 约束：
//   1) 标签页必须在任何退出路径上被关闭（成功/失败/超时/异常），否则会不断泄漏标签页；
//   2) 必须沿用 videoId 校验——拦截缓存是按 tabId 存的，不校验就可能把重定向后的
//      其它视频地址当成结果（下载到错误视频）；
//   3) 批量场景下要限制同时打开的标签页数，避免一次性弹出几十个标签页。

// 静默抓取的等待窗口：页面加载 + 播放器发起首段媒体请求，实测多在 1~2 秒内命中。
// 【2026-11-02 调整】9s → 13s。实测网络层就要 2~3s（首字节 1.5~2.5s，375KB 页面），
// 真实浏览器还要解析 HTML、执行 React 水合与风控脚本、初始化播放器，才发出媒体请求；
// 并发 8 个后台标签页时 CPU 竞争会进一步拖慢。
// 9s 正好卡在边缘 → "有时候解析失败"主要就是这里的超时。
// 放宽到 13s 的预算来源：第一段服务端源已全灭并接入熔断，省下的 ~5s 让给这里，
// 单条最坏耗时基本不变（熔断后 0+4+13≈17s，原为 5+4+9=18s），但有效窗口 +44%。
const SILENT_TAB_TIMEOUT_MS = 13000;
// 轮询拦截缓存的间隔：太密会空耗 CPU，太疏会白等
const SILENT_TAB_POLL_MS = 200;
// 并发上限必须跟上解析池的大批量宽度（pumpUntilIdle 内 poolSize 最大 8），
// 否则这里会变成整条流水线的瓶颈：实测模型（1370 条，每条 18s 上限）——
// 4 槽 = 103 分钟、8 槽 = 51 分钟，且把解析池从 4 放宽到 8 完全不产生收益。
// 之所以敢开这么高：标签页是 active:false 的后台页，且命中后立即关闭（通常存活 1~2 秒），
// 同时在线数远低于上限值。真正的风险是内存，因此配合 POOL 一道限制总量。
const SILENT_TAB_MAX_CONCURRENT = 8;
let _silentTabActive = 0;
const _silentTabWaiters = [];

function _acquireSilentSlot() {
  if (_silentTabActive < SILENT_TAB_MAX_CONCURRENT) {
    _silentTabActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => _silentTabWaiters.push(resolve));
}
function _releaseSilentSlot() {
  const next = _silentTabWaiters.shift();
  if (next) next();               // 名额直接移交给排队者，不递减计数
  else _silentTabActive = Math.max(0, _silentTabActive - 1);
}

// 静默打开 → 等待拦截命中 → 关闭。
// 返回与 parseViaIntercept 相同形状的结果对象；未命中则抛错（由竞速降级处理）。
// 静默标签页失败时的现场诊断：把"为什么没抓到"变成一句可读的话。
// 只读取状态、不改变页面行为；任何异常都吞掉，绝不影响主流程。
// 【2026-11-05 新增】此前超时只报"未拦截到地址"，无法区分
//   ① 页面被重定向到推荐流  ② 数据块返回 10204  ③ 后台标签页未被渲染导致播放器不发起请求
//   —— 这三者的修法完全不同，必须能分开。
async function diagnoseSilentTab(tabId, targetId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = {};
        try { out.url = location.href; } catch (e) { out.url = ''; }
        try { out.vis = document.visibilityState; } catch (e) { out.vis = '?'; }
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          if (!el) out.hasUniversal = false;
          else {
            out.hasUniversal = true;
            try {
              const j = JSON.parse(el.textContent || '{}');
              const vd = j && j.__DEFAULT_SCOPE__ && j.__DEFAULT_SCOPE__['webapp.video-detail'];
              out.statusCode = vd ? vd.statusCode : undefined;
              out.statusMsg = String((vd && vd.statusMsg) || '').slice(0, 40);
              const it = vd && vd.itemStruct;
              out.hasItem = !!it;
              out.playAddr = it && it.video && it.video.playAddr ? 1 : 0;
              out.bitrate = it && it.video && Array.isArray(it.video.bitrateInfo)
                ? it.video.bitrateInfo.length : 0;
            } catch (e) { out.parseErr = String(e.message).slice(0, 40); }
          }
        } catch (e) {}
        try {
          out.videoTags = document.querySelectorAll('video').length;
          const v = document.querySelector('video');
          out.videoSrc = v ? String(v.currentSrc || v.src || '').slice(0, 70) : '';
        } catch (e) {}
        try {
          out.mediaReqs = performance.getEntriesByType('resource')
            .filter(e => /\.(mp4|m3u8|webm)/i.test(e.name) || e.initiatorType === 'video').length;
        } catch (e) { out.mediaReqs = -1; }
        return out;
      }
    });
    const d = (r && r.result) || {};
    const parts = [];
    if (d.url) {
      const m = String(d.url).match(/\/(?:video|v|note)\/(\d+)/);
      const landed = m ? m[1] : '(非详情页)';
      parts.push('落地=' + (landed === String(targetId) ? '一致' : landed));
    }
    if (d.vis) parts.push('visible=' + d.vis);
    if (d.hasUniversal === false) parts.push('无UNIVERSAL块');
    if (d.statusCode !== undefined) parts.push('statusCode=' + d.statusCode + (d.statusMsg ? ' ' + d.statusMsg : ''));
    if (d.hasItem === false) parts.push('itemStruct缺失');
    if (d.bitrate) parts.push('bitrate=' + d.bitrate);
    if (d.videoTags !== undefined) parts.push('video标签=' + d.videoTags + (d.videoSrc ? '(' + d.videoSrc + ')' : ''));
    if (d.mediaReqs !== undefined) parts.push('媒体请求=' + d.mediaReqs);
    return parts.join(' · ') || '(无诊断信息)';
  } catch (e) {
    return '诊断不可用(' + String((e && e.message) || e).slice(0, 40) + ')';
  }
}

async function parseViaSilentTab(finalUrl, timeoutMs = SILENT_TAB_TIMEOUT_MS) {
  const urlId = extractVideoIdFromUrl(finalUrl);
  // 只对标准视频详情页开标签页：推荐页/主页/短链展开后的非详情地址没有确定的目标视频，
  // 开了也只会抓到"当前推荐流里的某个视频"，属于错误结果。
  if (!urlId) throw new Error('silent tab: 非视频详情页，跳过');

  await _acquireSilentSlot();
  let tabId = null;
  const startedAt = Date.now();
  try {
    const tab = await chrome.tabs.create({ url: finalUrl, active: false });
    tabId = tab?.id;
    if (!tabId) throw new Error('silent tab: 创建标签页失败');

    // 轮询等待拦截器写入地址。webRequest 回调是异步的，无法在此处直接 await，
    // 只能轮询缓存；同时穿插页面深挖作为加速路径（它直接读 DOM/脚本，往往更快）。
    let captured = null;
    let deepResult = null;
    // 深挖必须限次 + 递增间隔。
    // 【2026-11-05 修复】原先条件是「>600ms 且还没结果」，而轮询间隔只有 200ms
    // → 每 200ms 就往页面注入一次脚本，8 个静默页并发时是每秒数十次注入。
    // 这跟播放器初始化抢主线程，页面迟迟发不出媒体请求，**自己把自己拖到超时**。
    // 现限定最多 4 次，节点取 0.6s / 2s / 5s / 9s。
    const DEEP_AT_MS = [600, 2000, 5000, 9000];
    let deepIdx = 0;
    while (Date.now() - startedAt < timeoutMs) {
      captured = capturedVideoUrls.get(tabId);
      if (captured?.hdVideoUrl || captured?.videoUrl) break;
      // 页面深挖必须显式指定「静默标签页」：该标签页是 active:false 的后台页，
      // 若走默认的「当前激活标签页」，会读用户正在看的另一个页面（或被 videoId 校验挡下）。
      // 这条路径通常比等拦截更快，且能一并带回标题/作者等元数据。
      const elapsed = Date.now() - startedAt;
      if (!deepResult && deepIdx < DEEP_AT_MS.length && elapsed >= DEEP_AT_MS[deepIdx]) {
        deepIdx++;
        try {
          const d = await parseViaPageDeep(finalUrl, tabId);
          if (d?.success) { deepResult = d; break; }
        } catch (e) { /* 深挖失败不致命，继续等拦截 */ }
      }
      await sleep(SILENT_TAB_POLL_MS);
    }

    // 深挖成功优先返回（元数据更全）
    if (deepResult?.success) return deepResult;

    captured = capturedVideoUrls.get(tabId) || captured;
    if (!captured?.hdVideoUrl && !captured?.videoUrl) {
      // 带上现场诊断，便于一眼区分「重定向 / 10204 / 后台页未渲染」
      const diag = await diagnoseSilentTab(tabId, urlId);
      throw new Error('silent tab: 未拦截到地址（' + Math.round((Date.now() - startedAt) / 1000) + 's 超时）｜' + diag);
    }

    // 关键校验：标签页最终 URL 必须仍是同一个视频（TikTok 可能重定向/跳转到推荐流）。
    // 不校验就会把"跳过去之后自动播放的另一个视频"当成结果，导致下载到错误内容。
    let landedId = null;
    try {
      const info = await chrome.tabs.get(tabId);
      landedId = extractVideoIdFromUrl(info?.url || '');
    } catch (e) { /* 标签页已消失，交给下面的兜底判断 */ }
    if (landedId && landedId !== urlId) {
      throw new Error('silent tab: 落地视频不一致 ' + landedId + ' != ' + urlId);
    }

    let meta = {};
    try { meta = await extractPageMeta(tabId) || {}; } catch (e) {}
    return {
      success: true,
      originalUrl: finalUrl,
      id: urlId,
      title: meta.title || '无标题',
      author: meta.author || '未知作者',
      authorAvatar: '',
      cover: meta.cover || '',
      videoUrl: captured.videoUrl || captured.hdVideoUrl,
      hdVideoUrl: captured.hdVideoUrl || captured.videoUrl,
      duration: 0,
      quality: '原画质',
      language: '',
      likes: '',
      createTime: '',
      _parseSource: 'silent_tab'
    };
  } finally {
    // 任何路径都必须关掉标签页：用 finally 而非每处 catch，
    // 否则超时/异常路径会持续泄漏标签页，长批量任务下会开出成百上千个。
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (e) { /* 已被用户手动关闭 */ }
      capturedVideoUrls.delete(tabId);
    }
    _releaseSilentSlot();
  }
}

// 自建解析后端“单 mode”请求：
//   api  = 第三方源池（第一段“高清无水印快源”使用）
//   html = 页面直抓，item = TikTok 官方接口（下载前取新签名时按需使用）
// 注：解析主链路的第二段已不再调用 html/item —— 二者在服务端已失效（页面直抓 403、
// 官方 item 返回空结构），调用只会白等窗口。这里的 html/item 仅服务于
// fetchFreshDownloadUrls（该场景有独立超时，且失败可由旧地址兜底）。
async function parseViaOwnBackendMode(finalUrl, mode, timeoutMs = 6000, signal = null) {
  // 熔断 key 按 mode 分开（见 apiKey 对 fragment 的处理）：
  // api 走解析第一段，html/item 服务下载前取新签名，互不牵连。
  // 【2026-11-02 修复】原实现完全不接入熔断——第三方 API 连续失败 3 次会冷却 5 分钟，
  // 自建后端却每次都全速打满窗口。而 09-19 / 11-02 两次实测三个 mode 均长期全灭，
  // 于是每条视频都在第一段白等满 PARSE_FAST_HD_MS(5s)、零产出。
  const fuseKey = OWN_PARSE_API + '#' + mode;
  if (isApiInCooldown(fuseKey)) {
    throw new Error('backend ' + mode + ' 冷却中（近期连续失败）');
  }
  try {
    const resp = await fetchWithTimeout(
      OWN_PARSE_API + '?url=' + encodeURIComponent(finalUrl) + '&token=' + OWN_PARSE_TOKEN + '&mode=' + mode,
      {}, timeoutMs, signal);
    if (!resp.ok) throw new Error('backend HTTP ' + resp.status);
    const d = await resp.json();
    if (!d || !d.success) throw new Error((d && d.error) || 'backend parse failed');
    recordApiSuccess(fuseKey);
    return {
    success: true,
    originalUrl: finalUrl,
    id: d.id || Date.now(),
    title: d.title || '无标题',
    author: d.author || '未知作者',
    authorAvatar: d.authorAvatar || '',
    cover: d.cover || '',
    videoUrl: d.videoUrl || '',
    hdVideoUrl: d.hdVideoUrl || d.videoUrl || '',
    images: Array.isArray(d.images) ? d.images : [],
    type: d.type || 'video',
    duration: d.duration || 0,
    quality: (d.source === 'page') ? '原画质' : '高清',
    language: '',
    likes: d.likes || '',
    createTime: d.createTime || '',
      // ssstik / tkdl 返回的都是它们自己的代理直链（有效期见各自说明），
      // 不属于「页面当场签发的短命地址」，不应触发那轮取新签名（会白等最多 8s）。
      // 注：tkdl 的 snapcdn JWT 约 1 小时有效，批量解析后要及时下载。
      _parseSource: (mode === 'ssstik' || mode === 'tkdl') ? mode : 'own_backend'
    };
  } catch (e) {
    // 竞速命中后 stage1Abort 会主动取消落败请求，那属正常竞争而非后端故障，
    // 不能计入熔断（否则一次成功解析就会把其余源误判为故障、直接冷掉）。
    // 同理，调用方 abort 造成的取消也不应记失败。
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    if (!aborted) recordApiFailure(fuseKey);
    throw e;
  }
}

// 判定一个媒体 URL 是否“明显带水印”（playwm / watermark=1 / /watermark/ 等）。
// 用户要求“只要无水印”，带水印地址不作为解析结果与下载候选。
function looksWatermarked(rawUrl) {
  const u = String(rawUrl || '');
  if (!u) return false;
  // 明确无水印标记直接放行，避免误伤
  if (/watermark=0|wm=0|no_watermark|hdplay|hd_play|bitrate/i.test(u)) return false;
  return /playwm/i.test(u)
      || /watermark=1|wm=1/i.test(u)
      || /\/watermark\/|watermark\/1|_wm\.mp4/i.test(u);
}

async function parseVideo(url, opts = {}) {
  let finalUrl = url.trim();

  // 短链接展开（缩短超时，快速失败）
  if (finalUrl.includes('vm.tiktok.com') || finalUrl.includes('v.douyin.com')) {
    try {
      const resp = await fetchWithTimeout(finalUrl, { method: 'GET', redirect: 'follow' }, 5000);
      finalUrl = resp.url || finalUrl;
    } catch (e) {
      try {
        const resp = await fetchWithTimeout(finalUrl, { method: 'HEAD' }, 3000);
        finalUrl = resp.url || finalUrl;
      } catch (e2) {}
    }
  }

  const encoded = encodeURIComponent(finalUrl);
  const availableApis = getApiList(encoded).filter(api => !isApiInCooldown(api.url));
  const timeoutOf = (ms, msg) => new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
  // 逐段收集失败原因。原来每段 catch 只 console.log，最终统一返回「所有解析源均失败」，
  // 用户和日志都看不出是超时、重定向还是 10204 —— 这三种修法完全不同，必须保留。
  const failReasons = [];
  // 收尾：统一 originalUrl/id，并触发语言/评论异步补充。
  // 解析阶段不强制无水印：第一阶段扒到什么（含高清带水印）就用什么，速度优先；
  // “要无水印”在下载侧通过候选排序来满足（无水印优先，带水印作为降级保底）
  const finalize = (r) => {
    // 带上原始原因：原来一律抛 'parse fail'，会把「静默标签页超时｜落地=推荐流」
    // 这类关键线索直接抹掉，排查时只剩一句无信息量的报错。
    if (!r || !r.success) throw new Error((r && r.error) || 'parse fail');
    r.originalUrl = finalUrl;
    r.id = r.id == null || r.id === '' ? String(Date.now()) : String(r.id);
    // 展示字段归一化：第三方源会自己调 formatLikes/formatDate，而自建后端与页面直抓
    // 返回的是原始数字（点赞数、Unix 时间戳）。不统一就会出现界面显示
    // "📅 1785749013"、"❤️ 1904" 这种既难看又不一致的结果。
    if (r.createTime) {
      const ctStr = String(r.createTime);
      // 已经是 "MM.DD" 形式的跳过，避免把格式化结果再当时间戳换算
      if (!/^\d{1,2}\.\d{1,2}$/.test(ctStr)) r.createTime = formatDate(Number(r.createTime)) || '';
    }
    if (r.likes != null && r.likes !== '' && typeof r.likes === 'number') {
      r.likes = formatLikes(r.likes);
    }
    enrichVideoAsync(r);
    return r;
  };

  // ===== 第一段（最多 5 秒）：“高清无水印”快源优先 =====
  // 【2026-11-05 修正】此前只跑自建 `api` 一个 mode，而 `api`（第三方源池）长期全灭，
  // 导致第一段每条视频白等满 5 秒、零产出，"有时解析不出来"由此而来。
  // 实测发现被 09-17 误判为"已死"的 `html`（页面直抓）其实是**可用**的——
  // 当时用的是失效视频做测试，把"视频不存在"误读成"通道失效"。
  // 现在四个自研端口一起竞速（Promise.any 谁先成功用谁）：
  //   html   ≈1.5s 页面直抓，返回真实 playAddr（主力）
  //   tkdl   ≈1.1s tikdownloader/tikvid，给 snapcdn 直链，**有 HD 档**且实测不限流
  //   ssstik ≈1.5s 第三方兑换直链（会限流，仅作补充）
  //   api    兜底，第三方源池（多数已死，失败不影响其他三个）
  const stage1Abort = new AbortController();
  const fastHdSources = [];
  for (const ownMode of ['html', 'tkdl', 'ssstik', 'api']) {
    fastHdSources.push(
      parseViaOwnBackendMode(finalUrl, ownMode, PARSE_FAST_HD_MS, stage1Abort.signal)
        .then(finalize).catch(e => { throw e; })
    );
  }
  for (const api of availableApis) {
    fastHdSources.push(fetchAndParse(api, PARSE_FAST_HD_MS, stage1Abort.signal).then(r => {
      r._parseSource = 'third_party';
      return finalize(r);
    }).catch(e => { throw e; }));
  }
  let rFast = null;
  try {
    rFast = await Promise.race([
      Promise.any(fastHdSources),
      timeoutOf(PARSE_FAST_HD_MS, '高清无水印快源超时')
    ]);
  } catch (e) {
    console.log('[解析] 第一段高清无水印未命中（' + PARSE_FAST_HD_MS + 'ms），切本地通道:', e.message);
    failReasons.push('高清段:' + (e.message || e));
  } finally {
    stage1Abort.abort();
  }
  if (rFast?.success) return rFast;

  // ===== 第二段 A（最多 4 秒）：已在手的本地通道 =====
  // 「本地拦截 / 页面深挖 / FetchHTML」——走浏览器自身的登录态与出口 IP，
  // 不受服务端数据中心 IP 被 TikTok 风控的影响。这一段的共同点是"无需新开页面"：
  // 要么已有拦截缓存，要么当前标签页就在目标视频上，因此可以给较短窗口。
  //
  // 已移除：自建后端 html（页面直抓）/ item（TikTok 官方接口）两个源。
  // 移除原因（2026-09-17 实测）：这两条在服务端已全线失效——页面直抓稳定返回
  // HTTP 403（CF 数据中心 IP 被拒），官方 item 接口返回空结构（item-detail empty），
  // 且自建后端未接入熔断，导致每个视频都要为它们白等满整个窗口，纯增延迟、零产出。
  // 恢复条件：服务端换用可用数据源并部署后，再把这两条加回来。
  //
  // 注：opts.skipIntercept 目前无调用方设置（保留作为出口）；下载前的取新签名走的是
  // fetchFreshDownloadUrls，不经过本函数的静默标签页通道，因此不会因下载而弹标签页。
  const stage2Abort = new AbortController();
  const origSources = [];
  // 本地拦截保留用于常规解析（拦截缓存里通常是最新的无水印地址）
  if (!opts.skipIntercept) {
    origSources.push(parseViaIntercept(finalUrl).then(finalize).catch(e => { throw e; }));
  }
  origSources.push(parseViaPageDeep(finalUrl).then(finalize).catch(e => { throw e; }));
  origSources.push(parseViaFetchHtml(finalUrl, stage2Abort.signal).then(finalize).catch(e => { throw e; }));

  let rOrig = null;
  try {
    rOrig = await Promise.race([
      Promise.any(origSources),
      timeoutOf(PARSE_ORIG_MS, '本地通道超时')
    ]);
  } catch (e) {
    console.log('[解析] 本地通道未命中（' + PARSE_ORIG_MS + 'ms）:', e.message);
    failReasons.push('本地:' + (e.message || e));
  } finally {
    stage2Abort.abort();
  }
  if (rOrig?.success) return rOrig;

  // ===== 第二段 B（最多 9 秒）：静默标签页抓取 =====
  // 页面不在当前标签页、拦截缓存也为空时的兜底：静默开一个后台标签页把视频页加载一遍，
  // 由 webRequest 拦截器抓下 CDN 地址后立即关闭。这是服务端源失效后唯一能稳定出原画质的通道。
  // 单独给窗口而不是并入上一段：它要真实加载页面（1~2s 起步），沿用 4 秒会大面积误杀。
  try {
    const r = await parseViaSilentTab(finalUrl, SILENT_TAB_TIMEOUT_MS);
    const fin = finalize(r);
    if (fin?.success) return fin;
  } catch (e) {
    console.log('[解析] 静默标签页未命中:', e.message);
    failReasons.push('静默:' + (e.message || e));
  }

  return {
    success: false,
    originalUrl: finalUrl,
    error: '所有解析源均失败' +
      (failReasons.length ? '｜' + [...new Set(failReasons)].slice(0, 3).join(' / ').slice(0, 220) : '')
  };
}

function extractVideoIdFromUrl(url) {
  const m = url.match(/\/video\/(\d+)/) || url.match(/\/v\/(\d+)/);
  return m ? m[1] : null;
}

async function extractPageMeta(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 优先从当前播放的视频卡片提取元数据
        try {
          const videoEl = document.querySelector('video');
          if (videoEl) {
            const container = videoEl.closest('[data-e2e="feed-item"]') 
                            || videoEl.closest('[class*="DivItemContainer"]')
                            || videoEl.parentElement?.parentElement;
            if (container) {
              const title = container.querySelector('[data-e2e="video-desc"]')?.textContent?.trim()
                         || container.querySelector('h1')?.textContent?.trim()
                         || container.querySelector('[class*="Desc"]')?.textContent?.trim()
                         || '';
              const author = container.querySelector('[data-e2e="browse-username"]')?.textContent?.trim()
                          || container.querySelector('a[href*="/@"]')?.textContent?.trim()
                          || container.querySelector('[class*="UserName"]')?.textContent?.trim()
                          || '';
              const cover = container.querySelector('img')?.src || '';
              if (title || author) return { title, author, cover };
            }
          }
        } catch (e) {}
        // 兜底：从 meta 标签提取
        return {
          title: document.querySelector('meta[property="og:title"]')?.content
               || document.querySelector('h1')?.textContent?.trim() || '',
          author: document.querySelector('meta[property="og:description"]')?.content?.match(/@(\w+)/)?.[1]
               || document.querySelector('[data-e2e="browse-username"]')?.textContent?.trim() || '',
          cover: document.querySelector('meta[property="og:image"]')?.content || ''
        };
      }
    });
    return result?.[0]?.result || {};
  } catch (e) { return {}; }
}

// ============================================================
//  模块六：后台解析队列 —— 3 个并发 worker 的共享池
//  队列里的 URL 不分任务先后，谁空谁领，同时最多解析 PARSE_POOL 个视频，
//  避免“一条任务跑完才跑下一条”造成的一个一个排队解析
// ============================================================
let parseTask = null;        // 池当前进度对象（供 popup 轮询/展示）
let parsePending = [];       // 待解析项 [{url, allowDuplicate}]，未被 worker 领走的
let poolRunning = false;     // 是否已有池在工作（防并发起多个池）
const PARSE_POOL = 3;        // 同时解析的视频数
const POOL_IDLE_MS = 800;    // 池空闲多久算本批结束（给新提交一个合并窗口）

async function loadCachedVideos() {
  const result = await chrome.storage.local.get('cachedVideos');
  return result.cachedVideos || [];
}

async function saveCachedVideos(videos) {
  await chrome.storage.local.set({ cachedVideos: videos });
}

function writeParseProgress(task) {
  if (!task) return Promise.resolve();
  return chrome.storage.local.set({ parseProgress: { ...task, queueLength: parsePending.length } }).catch(() => {});
}

async function startBackgroundParse(urls, allowDuplicate = false) {
  const list = (Array.isArray(urls) ? urls : []).map(u => String(u).trim()).filter(Boolean);
  if (list.length === 0) return { success: false, reason: '没有有效链接' };
  const hadRunning = !!(parseTask && parseTask.status === 'running');
  const items = list.map(url => ({ url, allowDuplicate: !!allowDuplicate }));
  parsePending.push(...items);
  // 池正在运行：直接并入当前任务（total 动态增长），由空闲 worker 接着领
  if (parseTask && parseTask.status === 'running') {
    parseTask.total += items.length;
    // 新并入的条目都还没解析成功，待完成量同步增加（否则进度会显示成负数/倒退）
    parseTask.pending = (parseTask.pending || 0) + items.length;
    writeParseProgress(parseTask);
  }
  ensurePool();
  return { success: true, queued: hadRunning, total: list.length, queueLength: parsePending.length };
}

function ensurePool() {
  if (poolRunning) return;
  poolRunning = true;
  (async () => {
    try {
      while (parsePending.length) {
        await pumpUntilIdle();
      }
    } finally {
      poolRunning = false;
      if (parsePending.length) ensurePool(); // 收尾瞬间又来了新任务，补跑
    }
  })();
}

// ---------- cachedVideos 的唯一写入口 ----------
// 背景：解析结果即时入列表、语言异步补充、文件大小异步回填，原本各自
// load → 改 → save 整表，三条链路并发时会互相覆盖（表现为“解析成功但列表里没有”
// 或文件大小丢失）。这里把所有读改写串行化到同一条队列上，从根上消除丢失更新。
const CACHED_MAX = 200;
let _cacheWriteQueue = Promise.resolve();
function mutateCachedVideos(mutator) {
  _cacheWriteQueue = _cacheWriteQueue.then(async () => {
    try {
      const all = (await loadCachedVideos()).map(v => ({ ...v, id: String(v.id) }));
      const next = mutator(all);
      if (next) await saveCachedVideos(next);
    } catch (e) { console.warn('[缓存] 写入失败:', e.message); }
  });
  return _cacheWriteQueue;
}

// 解析成功“即时入列表”：每解出一个就写一次缓存，
// 这样弹窗/侧边栏在解析过程中就能看到已完成的那几条，而不是等整批结束一次性出现。
function persistParsedToCache(video) {
  return mutateCachedVideos((all) => {
    const id = String(video.id);
    if (all.some(v => v.id === id)) return null; // 已存在，无需写
    all.unshift({ ...video, id });
    return all.length > CACHED_MAX ? all.slice(0, CACHED_MAX) : all;
  });
}

// 跑一批：3 个 worker 同时从 parsePending 领 URL，直到队列空 + 空闲一段时间才算本批结束
async function pumpUntilIdle() {
  const task = {
    id: Date.now(), total: parsePending.length, completed: 0,
    success: 0, failed: 0, skipped: 0, pending: parsePending.length,
    status: 'running', startedAt: Date.now(), stopped: false
  };
  parseTask = task;
  const results = [];
  const failedUrls = [];
  // 与 failedUrls 一一对应的失败原因。原来只存 URL，用户只看到「N 个失败」，
  // 完全无法判断是超时、被重定向还是 10204，只能靠猜。
  const failedReasons = [];
  const pushFail = (u, reason) => {
    failedUrls.push(u);
    failedReasons.push(String(reason || '未知原因').slice(0, 220));
  };
  let skippedCount = 0;
  let completed = 0;
  // 统一字符串 id：历史缓存里可能存在 number/string 混存或超过 2^53 丢失精度的 id
  const existing = (await loadCachedVideos()).map(v => ({ ...v, id: String(v.id) }));
  // 每次写进度前先回填计数，否则 popup 看到的 completed 会一直是 0
  // pending =「还没成功解析出来」的数量 = 总数 - 成功数 - 跳过数（跳过视为已达成目标）。
  // UI 展示的是它，而不是 completed：用户关心的是"还剩多少没拿到"，
  // 而 completed 会把失败项也算作"已完成"，看起来像在推进、实际没有产出。
  const persist = () => {
    task.completed = completed;
    task.success = results.length;
    task.failed = failedUrls.length;
    task.skipped = skippedCount;
    task.pending = Math.max(0, task.total - results.length - skippedCount);
    return writeParseProgress(task);
  };

  // 带重试的解析函数
  async function parseWithRetry(url, maxRetries = 1) {
    // 保留最后一次失败原因：原来重试耗完后直接 return { success:false }，
    // 把 parseVideo 已经算出来的具体原因（超时/重定向/10204）整个丢掉。
    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await Promise.race([
          parseVideo(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('解析超时')), 60000))
        ]);
        if (result.success) return result;
        lastError = (result && result.error) || lastError;
        if (attempt < maxRetries) await sleep(500);
      } catch (e) {
        lastError = (e && e.message) || lastError;
        if (attempt < maxRetries) await sleep(500);
        else throw e;
      }
    }
    return { success: false, error: lastError || '解析失败（无详情）' };
  }

  let lastPullAt = Date.now();
  async function worker() {
    // 用「本批任务的 stopped 标记」而不是全局变量作为停止条件：
    // 每批任务有各自的 task 对象，停止因此天然只作用于被点停的那一批，
    // 不会误伤随后提交的新任务（旧实现的全局标记会让新批次出现无人领取的空档）。
    while (!task.stopped) {
      // 用 pop() 取队尾：长队列下 shift() 是 O(n)，几千条会拖慢整体
      const item = parsePending.pop();
      if (!item) {
        if (Date.now() - lastPullAt > POOL_IDLE_MS) return; // 空转超时，本批结束
        await sleep(60);
        continue;
      }
      lastPullAt = Date.now();
      const { url, allowDuplicate } = item;
      // URL 级去重：该链接之前已成功解析过（本批结果或历史缓存）且允许跳过时，
      // 直接跳过、不发网络请求（避免旧链接被反复重解析）
      if (!allowDuplicate) {
        const alreadyParsed = existing.some(v => v.originalUrl === url)
                           || results.some(v => v.originalUrl === url);
        if (alreadyParsed) {
          skippedCount++;
          completed++;
          await persist();
          continue;
        }
      }
      try {
        const result = await parseWithRetry(url);
        if (result.success) {
          const vid = String(result.id);
          const exists = existing.some(v => v.id === vid);
          const dupInResults = results.some(v => String(v.id) === vid);
          if (!allowDuplicate && exists) skippedCount++;
          else if (!dupInResults) {
            result.id = vid;
            if (!result.originalUrl) result.originalUrl = url;
            results.push(result);
            // 即时写入缓存：列表实时显示已解析完成的那几条
            await persistParsedToCache(result);
          }
        } else {
          pushFail(url, result && result.error);
        }
      } catch (e) { pushFail(url, e && e.message); }

      completed++;
      await persist();
    }
  }

  // 动态并发：小队列/自动流保持 3 个防轰炸；一次性大批量(>6 条)自动放宽到 8 个，
  // 避免几千条的大列表被 3 个 worker 慢慢磨（旧代码大批量内部是 8 并发）
  const poolSize = parsePending.length > 6 ? 8 : PARSE_POOL;
  const workers = [];
  for (let w = 0; w < poolSize; w++) workers.push(worker());
  await Promise.all(workers);

  // 结果已逐条即时写入缓存（见 worker 内 persistParsedToCache），
  // 这里不再整批合并，只补发文件大小异步回填
  results.forEach((v) => fetchVideoSizeInBackground(v));

  task.status = 'done';
  task.completedAt = Date.now();
  // 收尾时归零：本批已结束，界面不应再显示"剩余 N 条未成功"的进行中文案
  task.pending = 0;
  // 失败原因一并落库：popup 侧即使错过通知，也能从 parseProgress 里读到具体原因。
  // 只保留前 20 条，避免长批量把 storage 写爆。
  task.failedReasons = failedReasons.slice(0, 20);
  await writeParseProgress(task);

  let msg = `成功 ${results.length} 个`;
  if (skippedCount > 0) msg += `，跳过 ${skippedCount} 个已存在`;
  if (failedUrls.length > 0) {
    msg += `，${failedUrls.length} 个失败`;
    // 通知里带上主要原因：只报"失败 N 个"等于没说，用户无法判断该查网络还是该重登。
    const uniq = [...new Set(failedReasons.map(r => String(r).split('｜')[0].trim()).filter(Boolean))];
    if (uniq.length) msg += `（${uniq.slice(0, 2).join('；')}${uniq.length > 2 ? ' 等' : ''}）`;
  }
  const title = task.stopped ? '⏹ 已停止解析' : (results.length > 0 ? '✅ 解析完成' : '⚠️ 解析完成');
  showNotification({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: msg, priority: 2 });

  // 只有 parseTask 仍指向本任务时才清空，防止误清随后启动的新池
  if (parseTask === task) parseTask = null;
}

// 后台获取文件大小（按 video.id 查找，修复 index 错位 bug）
async function fetchVideoSizeInBackground(video) {
  const url = video.hdVideoUrl || video.videoUrl;
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    const resp = await fetchWithTimeout(url, { method: 'HEAD' }, 10000);
    const len = resp.headers.get('Content-Length');
    if (!len) return;
    const fileSize = parseInt(len);
    if (!Number.isFinite(fileSize) || fileSize <= 0) return;

    // 走统一写入口（字符串化比较，兼容历史缓存中的 number/string id），
    // 避免与解析入列并发时互相覆盖
    await mutateCachedVideos((all) => {
      const idx = all.findIndex(v => v.id === String(video.id));
      if (idx === -1) return null;
      all[idx].fileSize = fileSize;
      return all;
    });
  } catch (e) { console.warn('文件大小获取失败:', e.message); }
}


// ============================================================
//  模块八：下载进度管理
// ============================================================
const downloadProgressMap = new Map(); // downloadId -> progress info
// 原画质(无水印)连续失败计数：key=videoId，失败满 3 次后允许自动降级到“高清/含带水印”地址下载
const originalQualityFailCounts = new Map();
let progressBroadcastTimer = null;

// 节流广播：最多每 500ms 写一次 storage，避免频繁 IO
function scheduleProgressBroadcast() {
  if (progressBroadcastTimer) return;
  progressBroadcastTimer = setTimeout(() => {
    progressBroadcastTimer = null;
    const obj = {};
    for (const [id, p] of downloadProgressMap) obj[id] = p;
    chrome.storage.local.set({ downloadProgress: obj }).catch(() => {});
  }, 300);
}

function updateDownloadProgress(downloadId, patch) {
  const existing = downloadProgressMap.get(downloadId) || {};
  downloadProgressMap.set(downloadId, { ...existing, ...patch });
  scheduleProgressBroadcast();
}

function removeDownloadProgress(downloadId) {
  downloadProgressMap.delete(downloadId);
  scheduleProgressBroadcast();
}

// 下载状态对账：MV3 的 SW 被回收后内存进度表会丢，而 storage 里的旧进度会残留成
// “幽灵进度条”（永远停在下载中）。这里以 chrome.downloads 的真实状态为准重建进度表：
// 仍在进行的保留并刷新字节数，已完成/已中断的清除。
async function reconcileDownloadProgress() {
  try {
    const stored = (await chrome.storage.local.get('downloadProgress')).downloadProgress || {};
    const items = await chrome.downloads.search({ state: 'in_progress' });
    const live = {};
    for (const it of items) {
      const prev = stored[it.id];
      if (!prev) continue; // 不是本扩展创建的下载，不接管
      live[it.id] = {
        ...prev,
        state: 'in_progress',
        bytesReceived: it.bytesReceived || prev.bytesReceived || 0,
        totalBytes: it.totalBytes || prev.totalBytes || 0
      };
    }
    downloadProgressMap.clear();
    for (const [id, p] of Object.entries(live)) downloadProgressMap.set(Number(id), p);
    await chrome.storage.local.set({ downloadProgress: live });
    if (Object.keys(stored).length !== Object.keys(live).length) {
      console.log(`[下载] 进度对账完成：清理 ${Object.keys(stored).length - Object.keys(live).length} 条残留记录`);
    }
  } catch (e) {
    console.warn('[下载] 进度对账失败:', e.message);
  }
}

// 错误码翻译（覆盖 chrome.downloads.InterruptReason 的全部常见取值，
// 避免用户只看到 FILE_NAME_TOO_LONG 之类的原始英文码）
function translateDownloadError(errorCode) {
  const map = {
    'NETWORK_FAILED': '网络连接失败', 'NETWORK_TIMEOUT': '网络超时', 'NETWORK_IO_ERROR': '网络读写错误',
    'NETWORK_DISCONNECTED': '网络已断开', 'NETWORK_SERVER_DOWN': '服务器无响应',
    'NETWORK_INVALID_REQUEST': '网络请求无效',
    'SERVER_FAILED': '服务器错误', 'SERVER_ERROR': '服务器错误', 'SERVER_NO_RANGE': '服务器不支持断点续传',
    'SERVER_BAD_CONTENT': '服务器返回内容异常', 'SERVER_UNAUTHORIZED': '服务器拒绝访问（需鉴权）',
    'SERVER_CERT_PROBLEM': '服务器证书错误', 'SERVER_FORBIDDEN': '服务器禁止访问',
    'SERVER_UNREACHABLE': '无法连接服务器', 'SERVER_CONTENT_LENGTH_MISMATCH': '文件大小与服务器声明不一致',
    'SERVER_CROSS_ORIGIN_REDIRECT': '服务器跨域重定向被拒绝',
    'FILE_FAILED': '文件保存失败', 'FILE_ACCESS_DENIED': '没有文件夹写入权限',
    'FILE_NO_SPACE': '磁盘空间不足', 'FILE_TOO_LARGE': '文件过大',
    'FILE_NAME_TOO_LONG': '文件名过长，请缩短保存路径',
    'FILE_TRANSIENT_ERROR': '文件系统临时错误', 'FILE_BLOCKED': '文件被阻止',
    'FILE_SECURITY_CHECK_FAILED': '文件安全校验失败', 'FILE_TOO_SHORT': '文件内容不完整',
    'FILE_VIRUS_INFECTED': '文件被安全软件拦截', 'FILE_HASH_MISMATCH': '文件校验不一致',
    'USER_CANCELED': '用户取消下载', 'USER_SHUTDOWN': '系统关机中断',
    'CRASH': '浏览器异常中断', 'TIMEOUT': '下载超时'
  };
  return map[errorCode] || errorCode || '未知错误';
}

// ============================================================
//  模块九：下载核心（优化版）
// ============================================================

// 文件名安全化：
//  - 过滤非法字符与控制字符，压缩空白
//  - 去掉结尾的点与空格（Windows 上会导致保存失败或静默改名）
//  - 按 UTF-8 字节数截断（NTFS 单段文件名上限 255 字节；这里留足余量，
//    因为 Chrome 还会在重名时追加 " (1)"，且要预留扩展名）
function safeFileName(text, maxBytes = 120) {
  // 顺序很重要：先把空白（含 tab/换行）归并为单个空格，再替换非法字符，
  // 否则制表符会先被控制字符规则变成下划线，得到 "a b_c" 这种奇怪结果
  let s = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  const byteLen = (t) => new TextEncoder().encode(t).length;
  if (byteLen(s) > maxBytes) {
    let out = '';
    for (const ch of s) {
      if (byteLen(out + ch) > maxBytes) break;
      out += ch;
    }
    s = out.replace(/[. ]+$/, '');
  }
  return s;
}

// ---------- 图集下载：逐张下载图片（监听每张完成/失败，结束后清理进度） ----------
async function downloadPhotoImages(video, language = '') {
  const images = (Array.isArray(video.images) ? video.images : []).filter(u => u && /^https?:\/\//i.test(u));
  if (!images.length) return { success: false, error: '无图片链接' };
  const dateStr = video.createTime ? String(video.createTime).replace(/[^\d.]/g, '') : '';
  // 与视频命名保持一致：标题参与命名，避免同作者同日期图集大量重名；
  // 总长按字节截断并过滤非法/尾字符，防止 FILE_NAME_TOO_LONG 与 Windows 保存失败
  const base = safeFileName(
    [video.likes, dateStr, video.author || 'unknown', video.title].filter(Boolean).join('_'), 110
  ) || 'tiktok_photo';
  const downloadIds = [];

  // 启动一张图片：直连下载；被拒/失败时自动改走自建代理
  const startOne = (imageUrl, filename) => new Promise((resolve) => {
    chrome.downloads.download({ url: imageUrl, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || !id) {
        // 直连失败 → 自建代理兜底
        chrome.downloads.download({ url: OWN_PROXY_API + encodeURIComponent(imageUrl), filename, saveAs: false }, (id2) => {
          if (chrome.runtime.lastError || !id2) { resolve(null); return; }
          updateDownloadProgress(id2, { videoId: video.id, filename, state: 'in_progress', bytesReceived: 0, totalBytes: 0, startTime: Date.now() });
          resolve(id2);
        });
        return;
      }
      updateDownloadProgress(id, { videoId: video.id, filename, state: 'in_progress', bytesReceived: 0, totalBytes: 0, startTime: Date.now() });
      resolve(id);
    });
  });

  for (let i = 0; i < images.length; i++) {
    const m = images[i].match(/\.(png|jpe?g|webp)/i);
    const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
    const filename = base + '_photo_' + String(i + 1).padStart(2, '0') + '.' + ext;
    try {
      const id = await startOne(images[i], filename);
      if (id) downloadIds.push(id);
    } catch (e) {}
  }
  if (downloadIds.length === 0) return { success: false, error: '图片下载创建失败', url: images[0] };

  // 等待单张图片结束（complete / interrupted / 超时），结束后写状态并清理进度
  const waitFinish = (downloadId) => new Promise((resolve) => {
    let settled = false;
    // listener / timer 先声明再赋值：finish 会在 search 回调或超时里被调用，
    // 若两者仍处于 TDZ 会抛 ReferenceError
    let listener = null;
    let timer = null;
    const finish = (state, error) => {
      if (settled) return;
      settled = true;
      if (listener) chrome.downloads.onChanged.removeListener(listener);
      if (timer) clearTimeout(timer);
      updateDownloadProgress(downloadId, { state, error: error || '' });
      setTimeout(() => removeDownloadProgress(downloadId), 5000);
      resolve(state === 'complete');
    };
    listener = (delta) => {
      if (delta.id !== downloadId || settled) return;
      if (delta.state?.current === 'complete') finish('complete');
      else if (delta.error?.current) finish('error', translateDownloadError(delta.error.current));
    };
    chrome.downloads.onChanged.addListener(listener);
    // 处理“监听挂上之前就已结束”的极快下载
    chrome.downloads.search({ id: downloadId }, (items) => {
      const it = items && items[0];
      if (!it || settled) return;
      if (it.state === 'complete') finish('complete');
      else if (it.state === 'interrupted') finish('error', translateDownloadError(it.error || '未知错误'));
    });
    timer = setTimeout(() => finish('error', '图片下载超时'), 60000);
  });

  const states = await Promise.all(downloadIds.map(waitFinish));
  const ok = states.filter(Boolean).length;
  if (ok > 0) await recordDownloadedVideo(video.id);
  return ok === images.length
    ? { success: true, url: images[0] }
    : { success: ok > 0, error: '图集下载 ' + ok + '/' + images.length + ' 张成功', url: images[0] };
}
// ============================================================
//  下载策略增强（方案 C/A/D）
// ============================================================

// C：允许“浏览器直连下载”的 CDN 主机（不带 Referer/Cookie 也大概率放行）。
// 名单外的域名（Akamai 等校验严格）一律跳过直连、直接走代理，省掉注定失败的直连轮次。
const DIRECT_FRIENDLY_HOSTS = [
  'douyinvod.com', 'douyinpic.com', 'douyinstatic.com', 'zjcdn.com', 'bytecdn.cn',
  'bytecdntp.com', 'amemv.com', 'muscdn.com', 'ibytedtos.com'
];
function isDirectFriendlyHost(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    // 【2026-09-21 修复】`*-webapp-prime.tiktok.com` 必须排除在直连之外：
    // 它正是 Akamai 上校验最严的域（要求 Referer/Cookie），而 chrome.downloads 直连
    // 【无法携带 Referer】——Referer 属 forbidden header，且 DownloadOptions 没有
    // referrer 参数（只有 url/filename/headers 等）。因此直连必然 403，
    // 还要白等满 FIRST_STALL_CHECK_MS(30s) 才降级到代理。
    // 这正是"解析出原画质却下不下来"的直接原因之一（另一个是线上代理为旧版）。
    // 交给代理处理：代理侧已正确设置 Referer + Cookie + 多轮重试。
    if (h === 'webapp-prime.tiktok.com' || h.endsWith('-webapp-prime.tiktok.com')) return false;
    // tiktokv 有多个区域 TLD（.com / .eu / .asia ...），不能只认 .com：
    // 实测页面已出现 starling16-normal-useastred.tiktokv.eu 这类主机。
    if (h.includes('tiktokcdn')) return true;
    if (/(^|\.)tiktokv\.[a-z.]+$/.test(h)) return true;
    return DIRECT_FRIENDLY_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

// A：走代理前先让自建代理探测一次候选是否真的可取流。
// 用 GET + Range:bytes=0-0 而不是 HEAD：HEAD 响应按规范没有 body，拿不到代理返回的
// 结构化错误（如 502 upstream failed），排查时只剩一句"服务器错误"无从下手；
// 而该请求成功时只传输 1 个字节，成本可忽略。
// 返回：
//   false     = 明确是"错误页/过期链接"（200 + html/json/text），跳过该候选；
//   'blocked' = 代理本身不可用（401 token 不符 / 429 触发限流），继续换候选也没用；
//   null      = 无法判断 → 仍然发起真实下载试一次。
async function probeProxyCandidate(proxyUrl) {
  try {
    const resp = await fetchWithTimeout(proxyUrl, { headers: { 'Range': 'bytes=0-0' } }, 8000);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const isTextual = ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain');
    if (resp.status === 401 || resp.status === 429) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 120); } catch (e) {}
      console.warn(`[下载] 代理不可用 HTTP ${resp.status} ${detail}` +
        (resp.status === 401 ? '（token 不一致：后端已开启鉴权，请确认三处 token 相同）' : '（已触发 IP 限流）'));
      return 'blocked';
    }
    if (resp.ok && isTextual) {
      return false; // 200 + 网页/JSON/文本 → 过期签名返回的错误页
    }
    if (!resp.ok && isTextual) {
      // 把代理的结构化错误打出来：CDN 风控（lastStatus=403）与网络异常（lastStatus=-1）
      // 的处理方式完全不同，没有这行日志就只能靠猜
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
      console.warn(`[下载] 代理探测异常 HTTP ${resp.status}: ${detail}`);
      return null; // 不武断跳过：CDN 风控是间歇性的，真实下载仍可能成功
    }
    return null; // 其它（含非 2xx 非文本）：交给真实下载验证
  } catch (e) { return null; }
}

// 下载专用“取新签名”：不走 UI 的快速窗口，给更充足时间（每 mode 最长 8s）并只保留无水印地址，
// 提高“原画质下载前拿新鲜链接”的成功率
async function fetchFreshDownloadUrls(originalUrl) {
  const modes = ['html', 'api'];
  if (/\/video\/\d+|\/v\/\d+|\/note\/\d+/.test(originalUrl)) modes.push('item');
  const abort = new AbortController();
  const tries = modes.map(m => fetchWithTimeout(
    OWN_PARSE_API + '?url=' + encodeURIComponent(originalUrl) + '&token=' + OWN_PARSE_TOKEN + '&mode=' + m,
    {}, 8000, abort.signal
  ).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
   .then(d => (d && d.success) ? d : Promise.reject(new Error('no success'))));
  let d = null;
  try { d = await Promise.any(tries); } catch (e) { return { success: false }; }
  finally { abort.abort(); } // 命中后取消其余 mode 的请求
  const isHttp = (u) => /^https?:\/\//i.test(u);
  const hd = String(d.hdVideoUrl || '').trim();
  const v = String(d.videoUrl || '').trim();
  const cleanHd = (hd && isHttp(hd) && !looksWatermarked(hd)) ? hd : '';
  const cleanV = (v && isHttp(v) && !looksWatermarked(v)) ? v : '';
  return {
    success: !!(cleanHd || cleanV),
    freshUrl: cleanHd || cleanV,
    freshAltUrl: (cleanV && cleanV !== cleanHd) ? cleanV : ''
  };
}

// 「短命签名地址」来源判定：这些通道拿到的都是页面/接口当场签发的 CDN 地址，
// 有效期短、且校验 Referer/Cookie，下载前值得再取一次新签名。
//
// 必须用**精确列举**而不是宽泛前缀（原实现用 `fetch_` 前缀，把所有 fetch_* 一网打尽，
// 连 fetch_next 这种明确的高清来源也被当成原画质；`page` 子串同样过宽——
// 任何含 "page" 的源名都会命中）。2026-09-17 排查确认。
const SHORT_LIVED_SOURCES = new Set([
  'intercept',       // 页内 webRequest 拦截（playAddr）
  'silent_tab',      // 静默标签页拦截（playAddr）
  'own_backend',     // 自建后端（服务端签发）
  'page',            // 页面深挖的 page 分支
  // 以下为「页面 HTML / DOM 当场签发」的地址，有效期短、校验 Referer/Cookie，
  // 一律需要取新签名——不能因为"标签可能是高清"就跳过：
  'universal',       // parseViaPageDeep: 页内 __UNIVERSAL_DATA__
  'sigi',            // parseViaPageDeep: SIGI_STATE
  'fetch_universal', // parseViaFetchHtml: __UNIVERSAL_DATA__
  'fetch_sigi',      // parseViaFetchHtml: SIGI_STATE
  'fetch_next',      // parseViaFetchHtml: __NEXT_DATA__
  'fetch_field',     // 正则搜到的 playAddr/hdplay 字段
  'fetch_regex',     // 正则搜到的完整 mp4 地址
  'script_field',    // parseViaPageDeep: <script> 内字段
  'script_regex',    // parseViaPageDeep: <script> 内 URL
]);
function isShortLivedSource(video) {
  const src = String((video && video._parseSource) || '').trim().toLowerCase();
  if (!src) return false;
  if (SHORT_LIVED_SOURCES.has(src)) return true;
  // 前缀兜底：源名可能带后缀（如 own_backend_api），按明确前缀匹配，不再吞掉 fetch_next
  return /^(?:intercept|silent_tab|own_backend|page)(?:[_\-].*)?$/.test(src);
}

async function downloadSingleVideo(video, language = '') {
  const rawUrl = (video.hdVideoUrl || video.videoUrl || '').trim();
  // 解析结果来自不可控第三方，必须校验协议后才交给 chrome.downloads
  // （否则可能把 javascript:/data: 之类的地址传下去）
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
  // 图集：无视频链接但有图片列表 → 逐张下载图片
  if (!url && Array.isArray(video.images) && video.images.length) {
    return downloadPhotoImages(video, language);
  }
  if (!url) return { success: false, error: '无视频链接', url: null };

  // “原画质(无水印)”判定：失败满 3 次后允许自动降级到高清/带水印地址下载
  const isOrigQuality = /原画质/.test(String(video.quality || '')) || isShortLivedSource(video);
  const failKey = isOrigQuality ? String(video.id || video.originalUrl || '') : '';
  const allowFallback = isOrigQuality && (originalQualityFailCounts.get(failKey) || 0) >= 3;
  const recordOrigFail = () => {
    if (!failKey) return;
    const n = (originalQualityFailCounts.get(failKey) || 0) + 1;
    originalQualityFailCounts.set(failKey, n);
    if (n === 3) console.log('[下载] 原画质已连续失败 3 次，之后将自动降级下载');
  };

  // 构造文件名（点赞和日期放最前面）
  const nameParts = [];
  if (video.likes) nameParts.push(video.likes);
  if (video.createTime) nameParts.push(video.createTime);
  if (language && !['未知语言', '未知', '拉丁语系（未识别）'].includes(language)) {
    nameParts.push(language);
  }
  nameParts.push(video.author || 'unknown');
  // 标题片段始终参与命名：否则同作者同一天的多个视频会大量重名，
  // 下载目录里出现一堆 xxx (1).mp4 无从辨认
  const titleFrag = safeFileName(video.title, 40);
  if (titleFrag) nameParts.push(titleFrag);
  const nameBody = safeFileName(nameParts.filter(Boolean).join('_'), 120) || 'video';
  const filename = `${nameBody}.mp4`;

  // ---------- 单次下载（直连 URL 或代理 URL） ----------
  function runDownload(dlUrl) {
    const viaProxy = dlUrl.startsWith(OWN_PROXY_API);
    console.log(`[下载] ${viaProxy ? '代理' : '直连'}: ${filename}`);
    return new Promise(async (resolve) => {
      let downloadId;
      try {
        downloadId = await new Promise((resolve) => {
          let done = false;
          const finish = (id) => { if (!done) { done = true; resolve(id); } };
          try {
            chrome.downloads.download({ url: dlUrl, filename, saveAs: false }, (id) => {
              if (chrome.runtime.lastError) {
                console.warn('[下载] 创建失败:', chrome.runtime.lastError.message);
                finish(null);
              } else finish(id);
            });
          } catch (e) { finish(null); }
          // 兜底：API 回调若始终不触发，不能永久占死批量下载的并发槽位
          setTimeout(() => finish(null), 15000);
        });
      } catch (e) {
        resolve({ success: false, error: 'API异常: ' + e.message, url: dlUrl });
        return;
      }
      if (!downloadId) {
        resolve({ success: false, error: '下载创建失败（URL无效或被阻止）', url: dlUrl });
        return;
      }
      updateDownloadProgress(downloadId, {
        videoId: video.id, filename, state: 'in_progress',
        bytesReceived: 0, totalBytes: 0, startTime: Date.now()
      });
      let settled = false;
      const listener = (delta) => {
        if (delta.id !== downloadId || settled) return;
        if (delta.bytesReceived || delta.totalBytes) {
          const cur = downloadProgressMap.get(downloadId) || {};
          const newBytes = delta.bytesReceived?.current ?? cur.bytesReceived ?? 0;
          const now = Date.now();
          let speed = cur.speed || 0;
          if (cur.lastBytes && cur.lastTime && newBytes > cur.lastBytes) {
            const elapsed = (now - cur.lastTime) / 1000;
            if (elapsed > 0) {
              const instantSpeed = (newBytes - cur.lastBytes) / elapsed;
              speed = cur.speed ? cur.speed * 0.7 + instantSpeed * 0.3 : instantSpeed;
            }
          }
          updateDownloadProgress(downloadId, {
            bytesReceived: newBytes,
            totalBytes: delta.totalBytes?.current ?? cur.totalBytes ?? 0,
            speed, lastBytes: newBytes, lastTime: now
          });
        }
        if (delta.state?.current === 'complete') {
          settled = true;
          chrome.downloads.onChanged.removeListener(listener);
          updateDownloadProgress(downloadId, { state: 'complete', bytesReceived: delta.bytesReceived?.current ?? 0 });
          console.log(`[下载] 完成: ${filename}`);
          setTimeout(() => removeDownloadProgress(downloadId), 5000);
          resolve({ success: true });
        }
        if (delta.error?.current) {
          settled = true;
          chrome.downloads.onChanged.removeListener(listener);
          const errMsg = translateDownloadError(delta.error.current);
          updateDownloadProgress(downloadId, { state: 'error', error: errMsg });
          setTimeout(() => removeDownloadProgress(downloadId), 8000);
          console.warn(`[下载] 错误: ${errMsg}`);
          resolve({ success: false, error: errMsg });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      // 兜底：下载可能在监听挂上之前就已结束（文件极小或立即失败），主动查一次当前状态，
      // 否则这类下载会一直等到超时判定被误判为“下载超时”。
      chrome.downloads.search({ id: downloadId }, (items) => {
        if (settled) return;
        const it = items && items[0];
        if (!it) return;
        if (it.state === 'complete') {
          settled = true;
          chrome.downloads.onChanged.removeListener(listener);
          updateDownloadProgress(downloadId, { state: 'complete', bytesReceived: it.bytesReceived || 0 });
          console.log(`[下载] 完成: ${filename}`);
          setTimeout(() => removeDownloadProgress(downloadId), 5000);
          resolve({ success: true });
        } else if (it.state === 'interrupted') {
          settled = true;
          chrome.downloads.onChanged.removeListener(listener);
          const errMsg = translateDownloadError(it.error || '未知错误');
          updateDownloadProgress(downloadId, { state: 'error', error: errMsg });
          setTimeout(() => removeDownloadProgress(downloadId), 8000);
          console.warn(`[下载] 错误: ${errMsg}`);
          resolve({ success: false, error: errMsg });
        }
      });
      // 超时策略：只在“完全无进展”时才取消。原画质/高清大文件动辄几百 MB，
      // 固定 120 秒一到就取消会把正在正常传输的大文件误杀（原画质失败高发原因之一）。
      // 只要 60 秒内有字节进展，就一直顺延观察，不打断下载。
      const STALL_MS = 60000;
      const checkTimeout = () => {
        if (settled) return;
        const cur = downloadProgressMap.get(downloadId);
        const lastActivity = (cur && cur.lastTime) || 0;
        if (lastActivity && Date.now() - lastActivity < STALL_MS) {
          // 仍在传输 → 继续观察
          setTimeout(checkTimeout, STALL_MS);
          return;
        }
        settled = true;
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.cancel(downloadId, () => {});
        updateDownloadProgress(downloadId, { state: 'error', error: '下载超时（无进展已取消）' });
        setTimeout(() => removeDownloadProgress(downloadId), 8000);
        resolve({ success: false, error: '下载超时（无进展）' });
      };
      setTimeout(checkTimeout, FIRST_STALL_CHECK_MS);
    });
  }

  // ============ 下载尝试（先拿新签名，再逐个候选） ============
  // 失败高发原因：列表里保存的 hdVideoUrl 是“解析当时”的签名链接，稍后就过期。
  // 原画质/无水印签名链接有效期短且校验 Referer/Cookie，过期链接直连还可能返回
  // “200 + 错误页”被当成下载成功（文件却是坏的），导致要反复点好几次才能下到好的。
  // 因此：原画质来源先做一次快速重解析拿到“新签名链接”，再按 新签名→旧地址 的顺序尝试，
  // 最后走代理兜底；保证一次点击内就把链路走完，不再拿过期链接空试。

  // 单视频总耗时预算：批量下载是 3 并发，如果某个视频的地址一直挂着不放，
  // 会长期占死 3 个槽位把后面的视频全堵住。预算耗尽就放弃该视频并释放槽位，
  // 让队列继续下载后面的（downloadBatchConcurrent 也会跳过对它的二次重试）。
  const EFFORT_MS = 70000; // 单视频最多折腾 70 秒
  const effortStart = Date.now();

  // 1) 先取新签名（仅对“原画质/页内拦截/自建后端/页面解析”等易过期来源执行，避免普通高清多等一轮）
  const isFreshNeeded = /原画质/.test(String(video.quality || ''))
    || isShortLivedSource(video);
  let freshUrl = '';
  let freshAltUrl = '';
  if (isFreshNeeded && video.originalUrl) {
    try {
      // 下载专用取新签名：不套用 UI 的 3s/2s 快速窗口，给每 mode 最长 8 秒，只保留无水印
      const fresh = await fetchFreshDownloadUrls(video.originalUrl);
      if (fresh && fresh.success) {
        freshUrl = fresh.freshUrl || '';
        freshAltUrl = fresh.freshAltUrl || '';
        if (freshUrl) console.log('[下载] 已取得新签名无水印链接');
      }
    } catch (e) {
      console.log('[下载] 获取新签名失败（继续用缓存地址尝试）:', e.message);
    }
  }

  // 2) 候选地址去重排序：无水印 → 高清/带水印(最后保底)。
  //    D：m3u8(HLS) 无法被浏览器直接存成可用 mp4，剔除。
  const hlsCandidates = [];
  const wmCandidates = []; // 带水印地址：先不优先；无水印候选缺失或失败满 3 次时才追加
  const candidates = [];
  const pushCand = (u) => {
    u = (u || '').trim();
    if (!u || !/^https?:\/\//i.test(u)) return; // 非 http(s) 地址一律丢弃
    if (candidates.includes(u) || hlsCandidates.includes(u) || wmCandidates.includes(u)) return;
    if (/\.m3u8(\?|$)/i.test(u)) hlsCandidates.push(u);
    else if (looksWatermarked(u)) wmCandidates.push(u);
    else candidates.push(u);
  };
  pushCand(freshUrl);
  pushCand(url);
  pushCand(freshAltUrl);
  pushCand(video.videoUrl);
  // 情况1：只有带水印地址（解析源没给无水印）→ 解析已不强制无水印，直接用它，别卡死下载
  if (!candidates.length && wmCandidates.length) {
    console.log('[下载] 无无水印候选，使用带水印(高清)地址');
    candidates.push(...wmCandidates);
  }
  // 情况2：有无水印候选但原画质失败满 3 次 → 追加带水印作为降级保底
  else if (allowFallback && wmCandidates.length) {
    console.log('[下载] 原画质失败≥3次，追加降级候选（高清/带水印）');
    candidates.push(...wmCandidates);
  }
  if (candidates.length === 0) {
    if (isOrigQuality) recordOrigFail();
    return hlsCandidates.length
      ? { success: false, error: '该视频仅有 HLS(m3u8) 流，无法直接保存为 mp4', url: null }
      : { success: false, error: '无视频链接', url: null };
  }

  // 3) 直连逐个尝试 —— C：只对“直连白名单 CDN”试直连；名单外的（Akamai 等校验严格）
  //    跳过直连，直接进代理环节，不再为注定失败的直连空耗时间。
  const directCandidates = candidates.filter(isDirectFriendlyHost);
  for (const cand of directCandidates) {
    if (Date.now() - effortStart >= EFFORT_MS) break; // 预算耗尽，让位给队列里的其它视频
    const r = await runDownload(cand);
    if (r.success) {
      await recordDownloadedVideo(video.id);
      return { ...r, url: cand };
    }
  }

  // 4) 自建代理逐个尝试（服务器带 Cookie+Referer 拉流）。
  //    A：先用一次 1 字节的 Range 探测候选，明确是「过期签名错误页」才跳过；
  //    其余情况（含代理自身报错）都交给真实下载验证——上游风控是间歇性的。
  let lastFail = null;
  let effortExhausted = false;
  for (const cand of candidates) {
    if (Date.now() - effortStart >= EFFORT_MS) { effortExhausted = true; break; }
    const proxyUrl = OWN_PROXY_API + encodeURIComponent(cand);
    const probe = await probeProxyCandidate(proxyUrl);
    if (probe === 'blocked') {
      // 代理鉴权失败 / 已限流：换候选也是同样的结果，直接终止代理环节
      lastFail = { success: false, error: '代理不可用（鉴权失败或已触发限流）' };
      break;
    }
    if (probe === false) {
      console.log(`[下载] 代理探测确认为错误页，跳过候选: ${cand.slice(0, 90)}`);
      lastFail = { success: false, error: '该地址为过期/错误页' };
      continue;
    }
    console.log(`[下载] 代理尝试: ${cand.slice(0, 90)}`);
    // 上游取流是间歇性的（CDN 风控实测同一签名约 50% 波动），单次失败不足以
    // 判定该候选不可用：重试 3 次并退避，比原来「失败一次就换候选」命中率高得多。
    let r3 = { success: false, error: '未发起下载' };
    for (let attempt = 1; attempt <= PROXY_DL_ATTEMPTS; attempt++) {
      if (Date.now() - effortStart >= EFFORT_MS) { effortExhausted = true; break; }
      r3 = await runDownload(proxyUrl);
      if (r3.success) break;
      if (attempt < PROXY_DL_ATTEMPTS) await sleep(attempt === 1 ? 600 : 1500);
    }
    lastFail = r3;
    if (r3.success) {
      await recordDownloadedVideo(video.id);
      return { ...r3, url: proxyUrl, viaProxy: true };
    }
  }
  if (effortExhausted && (!lastFail || !lastFail.error)) {
    lastFail = { success: false, error: '下载超时（已尽力 70 秒，跳过该视频）' };
  }
  // 到这里仍未成功：原画质视频累计一次失败（满 3 次后下次起自动带降级候选）
  if (isOrigQuality) recordOrigFail();

  // 单条失败必须在控制台留痕：逐候选/逐次重试的日志默认关闭（VERBOSE_LOG），
  // 但「到底试了几个候选、末次是什么错」是排查的唯一线索，必须无条件输出。
  console.warn(`[下载失败] ${filename} | 直连 ${directCandidates.length} 个候选 / 代理 ${candidates.length} 个候选 ×${PROXY_DL_ATTEMPTS} 次 | 末次：${(lastFail && lastFail.error) || '未知'}` +
    '（需要逐次明细请把 background.js 的 VERBOSE_LOG 改为 true）');

  return { ...(lastFail || { success: false, error: '下载失败' }), url, _gaveUp: effortExhausted };
}

// ---------- 下载历史记录（串行队列，防止并发覆盖） ----------
let _downloadedQueue = Promise.resolve();
async function recordDownloadedVideo(videoId) {
  if (!videoId) return;
  videoId = String(videoId);
  _downloadedQueue = _downloadedQueue.then(async () => {
    try {
      const storage = await chrome.storage.local.get('downloadedIds');
      const ids = (storage.downloadedIds || []).map(String);
      if (!ids.includes(videoId)) {
        ids.push(videoId);
        // 最多保留 500 条，避免无限增长
        if (ids.length > 500) ids.splice(0, ids.length - 500);
        await chrome.storage.local.set({ downloadedIds: ids });
      }
    } catch (e) { console.warn('[下载历史] 记录失败:', e.message); }
  });
  return _downloadedQueue;
}

// ---------- 单个下载请求处理 ----------
async function handleSingleDownload(video, sendResponse) {
  const result = await downloadSingleVideo(video, video.language || '');
  sendResponse(result);
}

// ---------- 并发批量下载（优化：失败自动重试） ----------
async function downloadBatchConcurrent(videos, concurrency = 3, progressCallback) {
  let successCount = 0, failCount = 0;
  const failedDetails = [];
  let index = 0, completed = 0;
  const total = videos.length;

  async function worker() {
    while (index < total) {
      const i = index++;
      const video = videos[i];

      let result = await downloadSingleVideo(video, video.language || '');

      // 失败重试一次；但若该视频已耗光单视频预算（_gaveUp），说明是顽固失败，
      // 不再重试，立即释放并发槽位给后面的视频，避免队列被“下载不下来的视频”堵死。
      if (!result.success && !result._gaveUp) {
        await sleep(500);
        result = await downloadSingleVideo(video, video.language || '');
      }

      completed++;
      if (result.success) successCount++;
      else { failCount++; failedDetails.push({ id: video.id, error: result.error, url: result.url }); }
      if (progressCallback) progressCallback(completed, total, successCount, failCount);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, total); w++) workers.push(worker());
  await Promise.all(workers);
  return { successCount, failCount, failedDetails };
}

// ---------- 批量下载入口 ----------
async function downloadAllVideosInBackground(videos, sendResponse) {
  const successVideos = videos.filter(v => v.success);
  if (successVideos.length === 0) {
    if (sendResponse) sendResponse({ success: false, reason: '没有可下载的视频' });
    showNotification({
      type: 'basic', iconUrl: 'icons/icon128.png', title: '下载失败', message: '没有可下载的视频'
    });
    return;
  }

  const toDownload = successVideos;
  const total = toDownload.length;

  if (sendResponse) {
    sendResponse({ success: true, started: true, total });
    sendResponse = null;
  }

  let notificationId = null;
  const createOrUpdateNotification = (completed, total, success, fail) => {
    const progress = Math.round((completed / total) * 100);
    const message = `已下载 ${completed}/${total}  成功 ${success}  失败 ${fail}`;
    const options = {
      type: 'progress', title: '下载进度', message, iconUrl: 'icons/icon128.png',
      progress, buttons: [{ title: '查看详情' }]
    };
    if (notificationId === null) {
      chrome.notifications.create(options, (id) => { notificationId = id; });
    } else {
      chrome.notifications.update(notificationId, options);
    }
  };

  createOrUpdateNotification(0, total, 0, 0);

  (async () => {
    try {
      const { successCount, failCount, failedDetails } = await downloadBatchConcurrent(
        toDownload, 3,
        (completed, total, success, fail) => createOrUpdateNotification(completed, total, success, fail)
      );

      let finalMessage = `成功 ${successCount} 个，失败 ${failCount} 个`;
      if (failCount > 0) {
        finalMessage += ' (详情请查看扩展控制台)';
        console.warn('[批量下载] 失败详情:', failedDetails);
      }

      chrome.notifications.update(notificationId, {
        type: 'progress', title: '下载完成', message: finalMessage,
        iconUrl: 'icons/icon128.png', progress: 100
      });
      // 进度通知 5 秒后清除
      setTimeout(() => { if (notificationId) chrome.notifications.clear(notificationId).catch(() => {}); }, 10000);
      showNotification({
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: '后台下载完成', message: finalMessage
      });
    } catch (e) {
      chrome.notifications.update(notificationId, {
        type: 'basic', title: '下载出错', message: e.message || '未知错误',
        iconUrl: 'icons/icon128.png'
      });
      setTimeout(() => { if (notificationId) chrome.notifications.clear(notificationId).catch(() => {}); }, 8000);
    }
  })();
}

// ============================================================
//  模块十：右键菜单 + 快捷键 + 侧边栏模式（只保留侧边栏）
// ============================================================
// 只保留侧边栏：点击扩展图标直接打开浏览器右侧的侧边栏（不再弹小窗）。
// openPanelOnActionClick 状态在部分浏览器重启后会重置，故后台每次启动都设置一次。
let _fallbackOnClickedRegistered = false;
async function enableSidePanelMode() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return;
    }
  } catch (e) {
    console.warn('[侧边栏] setPanelBehavior 失败:', e.message);
  }
  // 浏览器不支持 sidePanel（Firefox / 老内核 Chromium）→ 点图标改为打开独立窗口兜底
  if (chrome.action && chrome.action.onClicked && !_fallbackOnClickedRegistered) {
    _fallbackOnClickedRegistered = true;
    chrome.action.onClicked.addListener(() => {
      try {
        chrome.windows.create({
          url: chrome.runtime.getURL('popup.html') + '?window=1',
          type: 'popup', width: 680, height: 860, focused: true
        });
      } catch (e) {}
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'download-tiktok-video',
      title: '下载此视频',
      contexts: ['page', 'link'],
      documentUrlPatterns: ['*://*.tiktok.com/*', '*://*.douyin.com/*']
    });
  } catch (e) { console.warn('[菜单] 创建失败:', e.message); }
  enableSidePanelMode();
});

// 后台每次启动都确保“点图标=打开侧边栏”（部分浏览器重启后行为会重置）
enableSidePanelMode();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || tab.url;
  if (!url) return;
  const video = await parseVideo(url);
  if (!video.success) {
    showNotification({
      type: 'basic', iconUrl: 'icons/icon128.png', title: '下载失败', message: '视频解析失败'
    });
    return;
  }
  await downloadSingleVideo(video, video.language || '');
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'download-current-video') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url) {
      const video = await parseVideo(tab.url);
      if (!video.success) {
        showNotification({
          type: 'basic', iconUrl: 'icons/icon128.png', title: '下载失败', message: '当前页面视频解析失败'
        });
        return;
      }
      await downloadSingleVideo(video, video.language || '');
    }
  }
});

// ============================================================
//  模块十一：消息监听
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 心跳：弹窗/内容脚本用来确认后台脚本可用（个别浏览器后台启动失败时便于提示用户）
  if (message.type === 'ping') {
    try {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() });
    } catch (e) { sendResponse({ ok: false }); }
    return true;
  }

  if (message.type === 'start-parse') {
    const urls = message.urls || [];
    const allowDuplicate = message.allowDuplicate !== false;
    if (urls.length === 0) {
      sendResponse({ success: false, reason: '没有有效链接' });
      return true;
    }
    startBackgroundParse(urls, allowDuplicate).then(r => sendResponse(r));
    return true;
  }

  if (message.type === 'get-parse-progress') {
    if (parseTask) {
      sendResponse({ ...parseTask, queueLength: parsePending.length });
    } else {
      chrome.storage.local.get('parseProgress').then(r => {
        const progress = r.parseProgress || null;
        if (progress) progress.queueLength = parsePending.length;
        sendResponse(progress);
      });
    }
    return true;
  }

  if (message.type === 'stop-parse') {
    // 停止当前解析：标记本批任务停止 + 清空还没被 worker 领取的待解析项。
    if (parseTask) parseTask.stopped = true;
    parsePending = []; // 立即清空排队项
    if (parseTask?.status === 'running') {
      parseTask.stopped = true;
      parseTask.status = 'done';
      parseTask.completedAt = Date.now();
      chrome.storage.local.set({ parseProgress: { ...parseTask, queueLength: 0 } });
      sendResponse({ success: true, stopped: true });
    } else {
      // 清理 storage 里可能残留的 running 状态
      chrome.storage.local.get('parseProgress').then(r => {
        if (r.parseProgress?.status === 'running') {
          r.parseProgress.status = 'done';
          r.parseProgress.stopped = true;
          r.parseProgress.queueLength = 0; chrome.storage.local.set({ parseProgress: r.parseProgress });
        }
        sendResponse({ success: true, stopped: false });
      });
    }
    return true;
  }

  if (message.type === 'recommend-auto-parse') {
    const { videoId, author, pageUrl } = message;
    if (!videoId) {
      sendResponse({ success: false, reason: '无视频ID' });
      return true;
    }
    // 队列溢出防护：最多 20 个视频排队（3 个正在解析 + 17 个待解析）
    const totalQueued = parsePending.length + (parseTask?.status === 'running' ? PARSE_POOL : 0);
    if (totalQueued >= 20) {
      sendResponse({ success: false, reason: '队列已满' });
      return true;
    }
    // 拼装完整视频链接（优先带 @username，API 解析更稳定）
    let videoUrl;
    if (pageUrl && pageUrl.includes('tiktok.com')) {
      try {
        const u = new URL(pageUrl);
        if (author) {
          videoUrl = `${u.origin}/@${author}/video/${videoId}`;
        } else {
          videoUrl = `${u.origin}/video/${videoId}`;
        }
      } catch (e) {
        videoUrl = author ? `https://www.tiktok.com/@${author}/video/${videoId}` : `https://www.tiktok.com/video/${videoId}`;
      }
    } else if (pageUrl && pageUrl.includes('douyin.com')) {
      videoUrl = `https://www.douyin.com/video/${videoId}`;
    } else {
      videoUrl = author ? `https://www.tiktok.com/@${author}/video/${videoId}` : `https://www.tiktok.com/video/${videoId}`;
    }
    // 送入现有解析队列
    startBackgroundParse([videoUrl], false).then(r => {
      sendResponse({ success: true, ...r, videoId, videoUrl });
    });
    return true;
  }

  if (message.type === 'download-single') {
    const video = message.video;
    if (!video || !video.success) {
      sendResponse({ success: false, reason: '无效的视频信息' });
      return true;
    }
    handleSingleDownload(video, sendResponse);
    return true;
  }

  if (message.type === 'download-all-background') {
    const videos = message.videos;
    if (!videos || !Array.isArray(videos)) {
      sendResponse({ success: false, reason: '无效的视频列表' });
      return true;
    }
    downloadAllVideosInBackground(videos, sendResponse);
    return true;
  }

  // 查询当前下载进度（popup 轮询用）
  if (message.type === 'get-download-progress') {
    const obj = {};
    for (const [id, p] of downloadProgressMap) obj[id] = p;
    sendResponse(obj);
    return true;
  }

  // 查询 API 熔断状态
  if (message.type === 'get-api-cooldown') {
    const cooldownList = [];
    // apiCooldownUntil 的 key 现在就是 API 主机名
    for (const [hostname, until] of apiCooldownUntil) {
      if (Date.now() < until) {
        cooldownList.push({ url: hostname, hostname, cooldownUntil: until, remainingMs: until - Date.now() });
      }
    }
    sendResponse({ cooldown: cooldownList, total: cooldownList.length });
    return true;
  }

  return false;
});

// 启动时清理旧的 running 状态（防止异常退出后一直显示解析中）
// MV3 的 SW 被回收会打断正在跑的解析池：这里如实把状态收尾并提示用户，
// 避免 UI 永远停在“解析中 N/M”。
// 用同一个 Promise 去重并发调用：SW 启动时「顶层 IIFE」与 onStartup 会同时触发，
// 不去重可能弹出两条相同通知。
let _cleanupPromise = null;
function cleanupInterruptedParse() {
  if (_cleanupPromise) return _cleanupPromise;
  _cleanupPromise = (async () => {
    try {
      const { parseProgress } = await chrome.storage.local.get('parseProgress');
      if (parseProgress?.status === 'running') {
        const done = parseProgress.success || 0;
        // 未完成量：总数减去已成功、已跳过的部分，就是用户需要重新发起解析的条数
        const pending = Math.max(0, (Number(parseProgress.total) || 0) - done - (Number(parseProgress.skipped) || 0));
        parseProgress.status = 'done';
        parseProgress.completedAt = Date.now();
        parseProgress.queueLength = 0;
        parseProgress.pending = 0;
        await chrome.storage.local.set({ parseProgress });
        console.warn(`[解析] 上次解析被后台回收中断（已成功 ${done} 项，剩余 ${pending} 项未完成），已保留已完成结果`);
        showNotification({
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '⚠️ 上次解析被中断',
          message: `后台被浏览器回收，已成功 ${done} 项并保留；剩余 ${pending} 项未完成，请重新发起解析。`
        });
      }
    } catch (e) {}
  })();
  return _cleanupPromise;
}

// SW 每次启动都要做的状态对账
(async () => {
  await cleanupInterruptedParse();
  await reconcileDownloadProgress();
})();

// 浏览器启动时的对账（onStartup 早于 SW 首次执行，单独挂一次）
try {
  chrome.runtime.onStartup.addListener(() => {
    reconcileDownloadProgress();
    cleanupInterruptedParse();
  });
} catch (e) {}

console.log('TikTok下载器 v' + chrome.runtime.getManifest().version +
  ' 后台已启动（拦截+主动抓取+深度解析+FetchHTML+下载进度+熔断+速度+历史+持久化+侧边栏+推荐页自动解析）');
