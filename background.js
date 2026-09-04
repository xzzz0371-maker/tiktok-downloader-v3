// ============================================================
// TikTok/抖音下载器 v3.1 - 后台服务
// 新增：网络请求拦截、页面深度解析、下载进度广播、下载逻辑优化
// v3.1：公共函数抽离到 common.js、API熔断、下载速度、下载历史、拦截持久化
// ============================================================
import { formatLikes, formatDate } from './common.js';

const API_TIMEOUT = 10000;
const DOWNLOAD_TIMEOUT = 120000; // 下载超时延长到 120 秒

// ---------- 工具函数 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 自动关闭的通知（默认 8 秒后自动清除，避免一直留在屏幕上）
function showNotification(options, autoCloseMs = 8000) {
  chrome.notifications.create(options, (id) => {
    if (autoCloseMs > 0) {
      setTimeout(() => chrome.notifications.clear(id).catch(() => {}), autoCloseMs);
    }
  });
}

async function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {})
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('请求超时');
    throw error;
  }
}

// ============================================================
//  模块一：浏览器网络请求拦截（SW休眠后从 storage.session 恢复）
// ============================================================
const capturedVideoUrls = new Map(); // tabId -> { videoUrl, hdVideoUrl, capturedAt }

const CDN_DOMAINS = ['tiktokcdn', 'douyinvod', 'douyinpic', 'douyinstatic', 'bytecdntp'];

function isVideoCdnUrl(url) {
  return CDN_DOMAINS.some(d => url.includes(d)) && /\.(mp4|m3u8|webm)(\?|$)/i.test(url);
}

// 节流写入 storage.session：最多每 1 秒写一次，避免频繁 IO
let _capturedSaveTimer = null;
function saveCapturedToSession() {
  if (_capturedSaveTimer) return;
  _capturedSaveTimer = setTimeout(() => {
    _capturedSaveTimer = null;
    const obj = {};
    for (const [k, v] of capturedVideoUrls) obj[k] = v;
    chrome.storage.session.set({ capturedVideoUrls: obj }).catch(() => {});
  }, 1000);
}

// SW 启动时从 storage.session 恢复拦截缓存
(async () => {
  try {
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
    if (tabId < 0 || !isVideoCdnUrl(url)) return;

    const existing = capturedVideoUrls.get(tabId) || {};
    // media 类型或 URL 含 hdplay/watermark=0 通常是无水印高清
    const isHd = type === 'media' || /hdplay|watermark=0|bitrate/i.test(url);

    if (isHd || !existing.hdVideoUrl) existing.hdVideoUrl = url;
    if (!existing.videoUrl) existing.videoUrl = url;
    existing.capturedAt = Date.now();
    capturedVideoUrls.set(tabId, existing);
    saveCapturedToSession();

    console.log(`[拦截] tab=${tabId} type=${type} hd=${isHd}`);
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
            const isCdn = e.name.includes('tiktokcdn') || e.name.includes('tiktokv')
                       || e.name.includes('douyinvod') || e.name.includes('douyinpic')
                       || e.name.includes('bytecdntp') || e.name.includes('bytecdn')
                       || e.name.includes('amemv.com') || e.name.includes('douyin.com')
                       || e.name.includes('muscdn') || e.name.includes('ibytedtos');
            const isVideo = /\.(mp4|m3u8|webm|flv)(\?|$)/i.test(e.name)
                         || e.initiatorType === 'video'
                         || e.name.includes('video_id') || e.name.includes('play_addr')
                         || e.name.includes('/video/') || e.name.includes('playwm');
            if (isCdn && isVideo) urls.push(e.name);
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
async function parseViaPageDeep(finalUrl) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs?.[0]?.id) throw new Error('no tab');

  const tabUrl = tabs[0].url || '';
  // 放宽检查：当前标签页必须是 TikTok/抖音域名
  const isTiktokOrDouyin = /tiktok\.com|douyin\.com/i.test(tabUrl);
  if (!isTiktokOrDouyin) throw new Error('tab not tiktok/douyin');

  // 提取 videoId（支持 /video/{id} 和 /v/{id} 两种格式）
  const getVideoId = (u) => {
    const m = u.match(/\/video\/(\d+)/) || u.match(/\/v\/(\d+)/);
    return m ? m[1] : null;
  };
  const urlId = getVideoId(finalUrl);
  const tabId = getVideoId(tabUrl);

  // 如果两边都有 videoId，要求一致；如果只有一边有，也允许注入
  if (urlId && tabId && urlId !== tabId) throw new Error('tab mismatch');

  let injectTimeoutId;
  const result = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
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

        // 数据源 5: performance API（放宽后缀限制，只要是 CDN 域名的媒体请求）
        try {
          const entries = performance.getEntriesByType('resource')
            .filter(e => {
              const isCdn = e.name.includes('tiktokcdn') || e.name.includes('douyinvod')
                         || e.name.includes('douyinpic') || e.name.includes('bytecdntp')
                         || e.name.includes('bytecdn');
              const isVideo = /\.(mp4|m3u8|webm)(\?|$)/i.test(e.name)
                           || e.initiatorType === 'video' || e.contentType?.includes('video');
              return isCdn && isVideo;
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
      info.quality = item.source === 'universal' || item.source === 'sigi' ? '原画质' : '高清';
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
async function parseViaFetchHtml(finalUrl) {
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
    }, 6000);
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
      info.quality = item.source === 'fetch_universal' || item.source === 'fetch_sigi' ? '原画质' : '高清';
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

  // 1. bitrateInfo 最高码率
  if (video.bitrateInfo && Array.isArray(video.bitrateInfo) && video.bitrateInfo.length > 0) {
    const sorted = [...video.bitrateInfo].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = sorted[0];
    let addr = '';
    if (best?.PlayAddr?.UrlList?.length) addr = best.PlayAddr.UrlList[0];
    else if (best?.playAddr?.urlList?.length) addr = best.playAddr.urlList[0];
    else if (best?.UrlList?.length) addr = best.UrlList[0];
    else if (best?.urlList?.length) addr = best.urlList[0];
    else if (best?.url) addr = best.url;
    if (addr?.startsWith('http')) { videoUrl = addr.trim(); hdVideoUrl = addr.trim(); }
  }

  // 2. downloadAddr
  if (!videoUrl && video.downloadAddr) {
    let addr = '';
    if (typeof video.downloadAddr === 'string') addr = video.downloadAddr;
    else if (video.downloadAddr.urlList?.length) addr = video.downloadAddr.urlList[0];
    else if (video.downloadAddr.UrlList?.length) addr = video.downloadAddr.UrlList[0];
    if (addr?.startsWith('http')) { videoUrl = addr.trim(); hdVideoUrl = addr.trim(); }
  }

  // 3. 多字段遍历
  if (!videoUrl) {
    const fields = ['hdplay', 'playAddr', 'play', 'play_url', 'src', 'video_url', 'url'];
    for (const field of fields) {
      const val = video[field];
      if (!val) continue;
      if (typeof val === 'string' && val.startsWith('http')) {
        videoUrl = val.trim();
        if (field === 'hdplay' || field === 'playAddr') hdVideoUrl = val.trim();
        break;
      }
      if (Array.isArray(val) && val.length) {
        const first = val[0];
        if (typeof first === 'string' && first.startsWith('http')) {
          videoUrl = first.trim();
          if (field === 'hdplay') hdVideoUrl = first.trim();
          break;
        }
        if (first?.url?.startsWith('http')) {
          videoUrl = first.url.trim();
          if (field === 'hdplay') hdVideoUrl = first.url.trim();
          break;
        }
      }
      if (val.urlList?.length) {
        const first = val.urlList[0];
        if (first?.startsWith('http')) { videoUrl = first.trim(); if (field === 'hdplay') hdVideoUrl = first.trim(); break; }
      }
      if (val.UrlList?.length) {
        const first = val.UrlList[0];
        if (first?.startsWith('http')) { videoUrl = first.trim(); if (field === 'hdplay') hdVideoUrl = first.trim(); break; }
      }
    }
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
    quality: '原画质',
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

      const cached = await loadCachedVideos();
      const idx = cached.findIndex(v => v.id === video.id);
      if (idx !== -1) {
        cached[idx].language = video.language;
        await saveCachedVideos(cached);
      }
    } catch (e) { console.warn('[异步补充] 失败:', e.message); }
  });
  return _enrichQueue;
}

// ============================================================
//  模块四：第三方 API（兜底）
// ============================================================
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
      parse: (data) => {
        if (data.code === 200 && data.data) {
          const vd = data.data.video_data || data.data;
          const author = data.data.author || {};
          return {
            success: true, id: vd.vid || vd.id || Date.now(), title: vd.desc || vd.title || '无标题',
            author: author.nickname || '未知作者', authorAvatar: author.avatar || '',
            cover: vd.cover || '', videoUrl: (vd.play || '').trim(),
            hdVideoUrl: (vd.hdplay || vd.play || '').trim(), duration: vd.duration || 0, quality: '高清',
            likes: formatLikes(vd.statistics?.digg_count || vd.digg_count || vd.stats?.diggCount || 0),
            createTime: formatDate(vd.create_time || vd.createTime || 0)
          };
        }
        return null;
      }
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
    // tiktokdl-api (Node.js/CoffeeScript) - 用户可自行部署
    {
      url: `https://tiktokdl-api.example.com/tiktok/api.php?url=${encoded}`,
      parse: (data) => {
        if (data?.video && Array.isArray(data.video) && data.video.length > 0) {
          const playUrl = data.video[0];
          if (playUrl) {
            return {
              success: true, id: Date.now(), title: 'TikTok Video',
              author: '未知作者', authorAvatar: '', cover: '',
              videoUrl: playUrl.trim(), hdVideoUrl: playUrl.trim(),
              duration: 0, quality: '高清', likes: '', createTime: ''
            };
          }
        }
        return null;
      }
    },
    // ===== 用户自定义 API 区域 =====
    // 部署好自己的 API 后，取消下面的注释并修改 URL
    // {
    //   url: `https://your-domain.com/api/hybrid/video_data?url=${encoded}&minimal=false`,
    //   parse: (data) => {
    //     if (data.code === 200 && data.data) {
    //       const vd = data.data.video_data || data.data;
    //       const author = data.data.author || {};
    //       return {
    //         success: true, id: vd.vid || vd.id || Date.now(),
    //         title: vd.desc || vd.title || '无标题',
    //         author: author.nickname || '未知作者', authorAvatar: author.avatar || '',
    //         cover: vd.cover || '',
    //         videoUrl: (vd.play || '').trim(),
    //         hdVideoUrl: (vd.hdplay || vd.play || '').trim(),
    //         duration: vd.duration || 0, quality: '高清',
    //         likes: formatLikes(vd.statistics?.digg_count || vd.digg_count || 0),
    //         createTime: formatDate(vd.create_time || vd.createTime || 0)
    //       };
    //     }
    //     return null;
    //   }
    // }
  ];
}

// ============================================================
//  API 熔断机制：连续失败3次后冷却5分钟，避免每次都等超时
// ============================================================
const apiFailureCount = new Map();   // apiUrl -> 连续失败次数
const apiCooldownUntil = new Map();  // apiUrl -> 冷却结束时间戳
const API_MAX_FAILURE = 3;
const API_COOLDOWN_MS = 5 * 60 * 1000; // 5分钟

function isApiInCooldown(apiUrl) {
  const until = apiCooldownUntil.get(apiUrl);
  if (until && Date.now() < until) return true;
  if (until && Date.now() >= until) {
    // 冷却结束，重置
    apiCooldownUntil.delete(apiUrl);
    apiFailureCount.set(apiUrl, 0);
  }
  return false;
}

function recordApiSuccess(apiUrl) {
  apiFailureCount.set(apiUrl, 0);
  apiCooldownUntil.delete(apiUrl);
}

function recordApiFailure(apiUrl) {
  const count = (apiFailureCount.get(apiUrl) || 0) + 1;
  apiFailureCount.set(apiUrl, count);
  if (count >= API_MAX_FAILURE) {
    apiCooldownUntil.set(apiUrl, Date.now() + API_COOLDOWN_MS);
    console.warn(`[熔断] API ${apiUrl} 连续失败${count}次，冷却5分钟`);
  }
}

async function fetchAndParse(apiDef) {
  const apiUrl = apiDef.url;
  try {
    const resp = await fetchWithTimeout(apiUrl, {}, 6000);
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
async function parseViaIntercept(finalUrl) {
  return Promise.race([
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tabs?.[0]?.id) throw new Error('no tab');
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

async function parseVideo(url) {
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
  const apis = getApiList(encoded);
  const availableApis = apis.filter(api => !isApiInCooldown(api.url));

  // ===== 并行解析：本地拦截 + 页面深度解析 + Fetch HTML + 前3个API =====
  // 谁先成功用谁的，大幅提升速度和成功率
  const sources = [];

  // 源1：本地拦截（3秒超时，快速失败）
  sources.push(parseViaIntercept(finalUrl).catch(e => { throw e; }));

  // 源2：页面深度解析
  sources.push(parseViaPageDeep(finalUrl).then(r => {
    r.originalUrl = finalUrl;
    enrichVideoAsync(r);
    return r;
  }).catch(e => { throw e; }));

  // 源3：Fetch HTML 解析
  sources.push(parseViaFetchHtml(finalUrl).then(r => {
    r.originalUrl = finalUrl;
    enrichVideoAsync(r);
    return r;
  }).catch(e => { throw e; }));

  // 源4-6：前3个第三方API并行
  for (let i = 0; i < Math.min(3, availableApis.length); i++) {
    sources.push(fetchAndParse(availableApis[i]).then(r => {
      r.originalUrl = finalUrl;
      r._parseSource = 'third_party';
      enrichVideoAsync(r);
      return r;
    }).catch(e => { throw e; }));
  }

  // 全部并行 + 12秒总超时，防止某个源卡住导致整体卡死
  try {
    const result = await Promise.race([
      Promise.any(sources),
      new Promise((_, reject) => setTimeout(() => reject(new Error('并行解析总超时')), 12000))
    ]);
    if (result?.success) return result;
  } catch (e) {
    console.log('[并行解析] 全部失败或超时:', e.message);
  }

  // 剩余API逐个降级（每个最多6秒）
  for (let i = 3; i < availableApis.length; i++) {
    try {
      const result = await fetchAndParse(availableApis[i]);
      result.originalUrl = finalUrl;
      result._parseSource = 'third_party';
      enrichVideoAsync(result);
      return result;
    } catch (e) { continue; }
  }

  return { success: false, originalUrl: finalUrl, error: '所有解析源均失败' };
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
//  模块六：后台解析队列（支持排队追加）
// ============================================================
let parseTask = null;
let parseQueue = []; // 等待中的解析任务 [{urls, allowDuplicate}]
let stopParseRequested = false; // 用户请求停止解析

async function loadCachedVideos() {
  const result = await chrome.storage.local.get('cachedVideos');
  return result.cachedVideos || [];
}

async function saveCachedVideos(videos) {
  await chrome.storage.local.set({ cachedVideos: videos });
}

async function updateParseProgress(patch) {
  if (parseTask) {
    Object.assign(parseTask, patch);
    await chrome.storage.local.set({ parseProgress: { ...parseTask, queueLength: parseQueue.length } });
  }
}

// 处理队列中的下一个任务
function processNextParseTask() {
  if (parseTask?.status === 'running') return;
  if (parseQueue.length === 0) return;
  const next = parseQueue.shift();
  startBackgroundParse(next.urls, next.allowDuplicate, true);
}

async function startBackgroundParse(urls, allowDuplicate = false, fromQueue = false) {
  if (parseTask?.status === 'running') {
    // 正在解析中，加入队列等待
    parseQueue.push({ urls, allowDuplicate });
    return { success: true, queued: true, total: urls.length, queueLength: parseQueue.length };
  }

  parseTask = {
    id: Date.now(), total: urls.length, completed: 0,
    success: 0, failed: 0, skipped: 0, status: 'running', startedAt: Date.now()
  };
  stopParseRequested = false;
  await chrome.storage.local.set({ parseProgress: { ...parseTask, queueLength: parseQueue.length } });

  (async () => {
    const results = [];
    const failedUrls = [];
    let skippedCount = 0;
    let completed = 0;
    const existing = await loadCachedVideos();
    const concurrency = 8;
    let index = 0;

    // 带重试的解析函数
    async function parseWithRetry(url, maxRetries = 1) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await Promise.race([
            parseVideo(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error('解析超时')), 120000))
          ]);
          if (result.success) return result;
          // 失败后等待 500ms 再重试
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500));
          else throw e;
        }
      }
      return { success: false };
    }

    async function worker() {
      while (index < urls.length && !stopParseRequested) {
        const i = index++;
        try {
          const result = await parseWithRetry(urls[i]);
          if (result.success) {
            const exists = existing.some(v => v.id === result.id);
            const dupInResults = results.some(v => v.id === result.id);
            if (!allowDuplicate && exists) skippedCount++;
            else if (!dupInResults) results.push(result);
          } else {
            failedUrls.push(urls[i]);
          }
        } catch (e) { failedUrls.push(urls[i]); }

        completed++;
        await updateParseProgress({
          completed, success: results.length,
          failed: failedUrls.length, skipped: skippedCount
        });
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, urls.length); w++) workers.push(worker());
    await Promise.all(workers);

    // 合并到缓存
    let allVideos = await loadCachedVideos();
    for (let i = results.length - 1; i >= 0; i--) allVideos.unshift(results[i]);
    // 缓存上限：最多保留 200 条，防止爆存储
    if (allVideos.length > 200) allVideos = allVideos.slice(0, 200);
    await saveCachedVideos(allVideos);

    // 异步获取文件大小（用 id 查找，避免 index 错位）
    results.forEach((v) => fetchVideoSizeInBackground(v));

    parseTask.status = 'done';
    parseTask.completedAt = Date.now();
    await chrome.storage.local.set({ parseProgress: { ...parseTask, queueLength: parseQueue.length } });

    let msg = `已解析 ${results.length} 个视频`;
    if (skippedCount > 0) msg += `，跳过 ${skippedCount} 个已存在`;
    if (failedUrls.length > 0) msg += `，${failedUrls.length} 个失败`;

    showNotification({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: results.length > 0 ? '✅ 解析完成' : '⚠️ 解析完成',
      message: msg, priority: 2
    });
    parseTask = null;

    // 处理队列中的下一个任务
    setTimeout(processNextParseTask, 300);
  })();

  return { success: true, taskId: parseTask.id, total: urls.length };
}

// 后台获取文件大小（按 video.id 查找，修复 index 错位 bug）
async function fetchVideoSizeInBackground(video) {
  const url = video.hdVideoUrl || video.videoUrl;
  if (!url) return;
  try {
    const resp = await fetchWithTimeout(url, { method: 'HEAD' }, 10000);
    const len = resp.headers.get('Content-Length');
    if (!len) return;
    const fileSize = parseInt(len);

    // 重新读取最新缓存，按 id 查找后更新
    const current = await loadCachedVideos();
    const idx = current.findIndex(v => v.id === video.id);
    if (idx !== -1) {
      current[idx].fileSize = fileSize;
      await saveCachedVideos(current);
    }
  } catch (e) { console.warn('文件大小获取失败:', e.message); }
}


// ============================================================
//  模块八：下载进度管理
// ============================================================
const downloadProgressMap = new Map(); // downloadId -> progress info
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

// 错误码翻译
function translateDownloadError(errorCode) {
  const map = {
    'NETWORK_FAILED': '网络连接失败', 'NETWORK_IO_ERROR': '网络读写错误',
    'NETWORK_DISCONNECTED': '网络已断开', 'SERVER_ERROR': '服务器错误',
    'SERVER_BAD_CONTENT': '服务器返回内容异常', 'SERVER_UNREACHABLE': '无法连接服务器',
    'FILE_FAILED': '文件保存失败', 'FILE_ACCESS_DENIED': '没有文件夹写入权限',
    'FILE_NO_SPACE': '磁盘空间不足', 'FILE_TOO_LARGE': '文件过大',
    'FILE_VIRUS_INFECTED': '文件被安全软件拦截', 'USER_CANCELED': '用户取消下载',
    'USER_SHUTDOWN': '系统关机中断', 'TIMEOUT': '下载超时'
  };
  return map[errorCode] || errorCode || '未知错误';
}

// ============================================================
//  模块九：下载核心（优化版）
// ============================================================
async function downloadSingleVideo(video, language = '') {
  const url = (video.hdVideoUrl || video.videoUrl || '').trim();
  if (!url) return { success: false, error: '无视频链接', url: null };

  // 构造文件名（点赞和日期放最前面）
  let safeAuthor = (video.author || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  if (safeAuthor.length > 50) safeAuthor = safeAuthor.substring(0, 50);
  const nameParts = [];
  if (video.likes) nameParts.push(video.likes);
  if (video.createTime) nameParts.push(video.createTime);
  if (language && !['未知语言', '未知', '拉丁语系（未识别）'].includes(language)) {
    nameParts.push(language);
  }
  nameParts.push(safeAuthor);
  let nameBody = nameParts.join('_');
  if (!video.likes && !video.createTime) {
    let safeTitle = (video.title || 'video').replace(/[\\/:*?"<>|]/g, '_');
    if (safeTitle.length > 80) safeTitle = safeTitle.substring(0, 80);
    nameBody = safeTitle;
  }
  const filename = `${nameBody}.mp4`;
  console.log(`[下载] 开始: ${filename}`);

  // 创建下载
  let downloadId;
  try {
    downloadId = await new Promise((resolve) => {
      chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) {
          console.warn('[下载] 创建失败:', chrome.runtime.lastError.message);
          resolve(null);
        } else resolve(id);
      });
    });
  } catch (e) {
    return { success: false, error: 'API异常: ' + e.message, url };
  }

  if (!downloadId) {
    return { success: false, error: '下载创建失败（URL无效或被阻止）', url };
  }

  // 初始化进度
  updateDownloadProgress(downloadId, {
    videoId: video.id, filename, state: 'in_progress',
    bytesReceived: 0, totalBytes: 0, startTime: Date.now()
  });

  // 监听下载变化
  const result = await new Promise((resolve) => {
    let settled = false;

    const listener = (delta) => {
      if (delta.id !== downloadId || settled) return;

      // 进度更新（含速度计算）
      if (delta.bytesReceived || delta.totalBytes) {
        const cur = downloadProgressMap.get(downloadId) || {};
        const newBytes = delta.bytesReceived?.current ?? cur.bytesReceived ?? 0;
        const now = Date.now();
        // 计算速度：与上次记录的差值 / 时间差
        let speed = cur.speed || 0;
        if (cur.lastBytes && cur.lastTime && newBytes > cur.lastBytes) {
          const elapsed = (now - cur.lastTime) / 1000;
          if (elapsed > 0) {
            const instantSpeed = (newBytes - cur.lastBytes) / elapsed;
            // 平滑处理：新速度占30%，旧速度占70%，避免抖动
            speed = cur.speed ? cur.speed * 0.7 + instantSpeed * 0.3 : instantSpeed;
          }
        }
        updateDownloadProgress(downloadId, {
          bytesReceived: newBytes,
          totalBytes: delta.totalBytes?.current ?? cur.totalBytes ?? 0,
          speed,
          lastBytes: newBytes,
          lastTime: now
        });
      }

      // 完成
      if (delta.state?.current === 'complete') {
        settled = true;
        chrome.downloads.onChanged.removeListener(listener);
        updateDownloadProgress(downloadId, { state: 'complete', bytesReceived: delta.bytesReceived?.current ?? 0 });
        console.log(`[下载] 完成: ${filename}`);
        // 延迟清理，让 popup 有机会显示完成状态
        setTimeout(() => removeDownloadProgress(downloadId), 5000);
        resolve({ success: true });
      }

      // 错误
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

    // 超时：取消下载并清理
    setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      chrome.downloads.cancel(downloadId, () => {
        // 忽略 cancel 的错误（可能已经完成）
      });
      updateDownloadProgress(downloadId, { state: 'error', error: '下载超时（已取消）' });
      setTimeout(() => removeDownloadProgress(downloadId), 8000);
      resolve({ success: false, error: '下载超时' });
    }, DOWNLOAD_TIMEOUT);
  });

  if (result.success) {
    await recordDownloadedVideo(video.id);
  }
  return { ...result, url };
}

// ---------- 下载历史记录（串行队列，防止并发覆盖） ----------
let _downloadedQueue = Promise.resolve();
async function recordDownloadedVideo(videoId) {
  if (!videoId) return;
  _downloadedQueue = _downloadedQueue.then(async () => {
    try {
      const storage = await chrome.storage.local.get('downloadedIds');
      const ids = storage.downloadedIds || [];
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

      if (!result.success) {
        await sleep(500); // 指数退避起点
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
//  模块十：右键菜单 + 快捷键
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-tiktok-video',
    title: '下载此视频',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['*://*.tiktok.com/*', '*://*.douyin.com/*']
  });
  // 侧边栏：点击扩展图标时打开 popup，不自动打开侧边栏
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

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
      sendResponse({ ...parseTask, queueLength: parseQueue.length });
    } else {
      chrome.storage.local.get('parseProgress').then(r => {
        const progress = r.parseProgress || null;
        if (progress) progress.queueLength = parseQueue.length;
        sendResponse(progress);
      });
    }
    return true;
  }

  if (message.type === 'stop-parse') {
    // 停止当前解析任务
    stopParseRequested = true;
    if (parseTask) {
      parseTask.status = 'done';
      parseTask.completedAt = Date.now();
      parseTask.stopped = true;
      chrome.storage.local.set({ parseProgress: { ...parseTask, queueLength: parseQueue.length } });
      parseTask = null;
      parseQueue = []; // 清空队列
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
    // 队列溢出防护：最多 20 个任务排队
    const totalQueued = (parseTask ? 1 : 0) + parseQueue.length;
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
    for (const [url, until] of apiCooldownUntil) {
      if (Date.now() < until) {
        // 提取 API 域名，方便显示
        try {
          const hostname = new URL(url).hostname;
          cooldownList.push({ url, hostname, cooldownUntil: until, remainingMs: until - Date.now() });
        } catch (e) {
          cooldownList.push({ url, hostname: url, cooldownUntil: until, remainingMs: until - Date.now() });
        }
      }
    }
    sendResponse({ cooldown: cooldownList, total: cooldownList.length });
    return true;
  }

  return false;
});

// 启动时清理旧的 running 状态（防止异常退出后一直显示解析中）
(async () => {
  try {
    const { parseProgress } = await chrome.storage.local.get('parseProgress');
    if (parseProgress?.status === 'running') {
      parseProgress.status = 'done';
      parseProgress.completedAt = Date.now();
      parseProgress.queueLength = 0;
      await chrome.storage.local.set({ parseProgress });
    }
  } catch (e) {}
})();

console.log('TikTok下载器 v3.4 后台已启动（拦截+主动抓取+深度解析+FetchHTML+下载进度+熔断+速度+历史+持久化+侧边栏+推荐页自动解析）');
