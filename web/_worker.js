// TikTok / Douyin 无水印下载器 - 网页版高级模式 Worker（Cloudflare Pages Advanced Mode）
// 部署：作为 web/_worker.js 与静态资源一起上传到 Pages。
// 路由：
//   - /api/parse?url=<视频链接>&token=<token>  自建解析后端（海外边缘多源轮询 + 页面直抓 + 健康探针）
//   - /api/proxy?url=<视频地址>                 视频流代理（附加 CORS + Content-Disposition，点击直接下载）
//   - 其余路径                                  回退到静态资源（index.html 等）
// 安全：token 鉴权 + IP 限流 + 代理域名白名单，防止被当开放代理/免费解析滥用。

const ALLOWED = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-cn.com', 'tiktokcdn-eu.com', 'tiktokcdn-in.com',
  'tiktokv.com', 'webapp-prime.tiktok.com',
  'douyinvod.com', 'zjcdn.com', 'douyin.com', 'iesdouyin.com',
  'amemv.com', 'bytecdn.cn', 'volccdn.com', 'byteimg.com', 'gstatic.com'
];

// 防滥用 token（插件/网页版内置，接口不公开宣传）
const TOKEN = 'tdp2026x7kq9mz3vn8clw4r';

const API_TIMEOUT = 8000;
const TOTAL_PARSE_TIMEOUT = 13000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 代理下载用 UA 轮询：TikTok CDN（Akamai）按请求特征风控，换 UA 可提升成功率
const PROXY_UAS = [
  UA,
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

// ---------- 基础工具 ----------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
  };
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  // TikTok webapp-prime CDN：v16-webapp-prime.tiktok.com 等（连字符结构，非子域名）
  if (h === 'webapp-prime.tiktok.com' || h.endsWith('-webapp-prime.tiktok.com')) return true;
  return ALLOWED.some(function (d) { return h === d || h.endsWith('.' + d); });
}

function jsonResponse(body, status, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
  return new Response(JSON.stringify(body), { status: status, headers: h });
}

function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout || API_TIMEOUT);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(tid));
}

function checkToken(url) {
  const t = url.searchParams.get('token') || '';
  return t === TOKEN;
}

// IP 限流：每 IP 每分钟最多 60 次
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(ts => now - ts < 60000);
  if (arr.length >= 60) { ipHits.set(ip, arr); return true; }
  arr.push(now);
  ipHits.set(ip, arr);
  return false;
}

// 源健康探针：连续 3 次失败冷却 5 分钟（与插件熔断一致）
const sourceHealth = new Map();
function sourceInCooldown(name) {
  const h = sourceHealth.get(name);
  if (!h) return false;
  if (h.until && Date.now() < h.until) return true;
  if (h.until && Date.now() >= h.until) { sourceHealth.delete(name); }
  return false;
}
function recordSource(name, ok) {
  const h = sourceHealth.get(name) || { fail: 0, until: 0 };
  if (ok) { h.fail = 0; h.until = 0; }
  else {
    h.fail = (h.fail || 0) + 1;
    if (h.fail >= 3) { h.until = Date.now() + 5 * 60 * 1000; h.fail = 0; }
  }
  sourceHealth.set(name, h);
}

// ============================================================
//  解析后端 /api/parse
// ============================================================

// URL 规范化：提取视频/图集 ID，重建标准链接（去 query 参数）
function normalizeUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return raw.trim(); }

  if (u.hostname.includes('tiktok.com') || u.hostname.includes('tiktokv.com')) {
    const m = u.pathname.match(/\/(?:@[\w.]+)?\/?(video|photo|v|slideshow)\/(\d+)/);
    if (m) return `https://www.tiktok.com/${u.pathname}`.split('?')[0];
  }
  if (u.hostname.includes('douyin.com') || u.hostname.includes('iesdouyin.com')) {
    const m = u.pathname.match(/\/video\/(\d+)/) || u.pathname.match(/\/share\/video\/(\d+)/);
    if (m) return `https://www.douyin.com/video/${m[1]}`;
    const p = u.pathname.match(/\/note\/(\d+)/);
    if (p) return `https://www.douyin.com/note/${p[1]}`;
  }
  return u.href.split('?')[0];
}

function extractVideoId(raw) {
  const m = raw.match(/\/(?:video|photo|v|slideshow|note)\/(\d+)/);
  return m ? m[1] : null;
}

// 从页面 HTML 提取视频/图集数据（海外边缘直抓；桌面 UA 失败自动换移动 UA 重试）
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// 兼容 playAddr 的多种形态：字符串 / {urlList} / {UrlList} / bitrateInfo 嵌套
function resolveAddr(vd) {
  const bit = (vd.bitrateInfo || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  const cands = [];
  if (bit?.PlayAddr?.UrlList) cands.push(...bit.PlayAddr.UrlList);
  if (bit?.playAddr?.urlList) cands.push(...bit.playAddr.urlList);
  if (bit?.playAddr?.UrlList) cands.push(...bit.playAddr.UrlList);
  for (const k of ['playAddr', 'downloadAddr', 'playUrl', 'downloadUrl', 'url']) {
    const val = vd[k];
    if (typeof val === 'string') { if (val.startsWith('http')) cands.push(val); }
    else if (val && typeof val === 'object') {
      const list = val.urlList || val.UrlList || [];
      if (Array.isArray(list)) cands.push(...list.filter(x => typeof x === 'string' && x.startsWith('http')));
      else if (typeof val.url === 'string' && val.url.startsWith('http')) cands.push(val.url);
    }
  }
  return cands.find(u => u.startsWith('http')) || '';
}

// ============================================================
//  抖音页面直抓（v.douyin.com / douyin.com/video|note 展开后的 HTML）
//  抖音在 window._ROUTER_DATA / self.__pace_f.push(...) 里塞了条目 JSON，
//  结构形如 loaderData[xxx].videoInfoRes.item_list[0]（video.play_addr.url_list）
// ============================================================

// 从给定起始 '{' 处截取配对的 JSON（感知字符串与转义），避免盲目 JSON.parse 大段 HTML
function sliceBalancedJson(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// 递归找出形如 { video: { play_addr: { url_list: [...] } } } 的抖音条目
function collectAwemeCandidates(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const x of node) collectAwemeCandidates(x, out, depth + 1);
    return;
  }
  if (node.video && node.video.play_addr && Array.isArray(node.video.play_addr.url_list)) {
    out.push(node);
    return; // 找到一个条目就不再深入
  }
  const keys = Object.keys(node);
  if (keys.length > 60) return; // 大对象不再深挖，防递归爆炸
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(node, k)) collectAwemeCandidates(node[k], out, depth + 1);
  }
}

function extractDouyinVideo(html) {
  const scripts = String(html).match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  const markers = [/window\._ROUTER_DATA\s*=\s*/, /self\.__pace_f\.push\(\s*/, /window\.__pace_f\.push\(\s*/];
  const found = [];
  for (const sc of scripts) {
    if (sc.length > 5 * 1024 * 1024) continue; // 防超大脚本
    const body = sc.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    for (const marker of markers) {
      const m = marker.exec(body);
      if (!m) continue;
      const braceIdx = body.indexOf('{', m.index);
      if (braceIdx < 0) continue;
      const json = sliceBalancedJson(body, braceIdx);
      if (!json || json.length < 200 || json.length > 4 * 1024 * 1024) continue;
      try {
        collectAwemeCandidates(JSON.parse(json), found, 0);
      } catch (e) { /* 下一个 marker */ }
      if (found.length) break;
    }
    if (found.length) break;
  }
  if (!found.length) return null;
  const a = found[0];
  const vd = a.video || {};
  const pa = vd.play_addr || {};
  const urlList = Array.isArray(pa.url_list) ? pa.url_list : [];
  const addr = urlList.find(u => typeof u === 'string' && u.startsWith('http')) || '';
  const images = Array.isArray(a.images)
    ? a.images.map(i => {
        const urls = (i && (i.url_list || (i.imageURL && i.imageURL.url_list))) || [];
        return urls.find(u => typeof u === 'string' && u.startsWith('http')) || '';
      }).filter(Boolean)
    : [];
  if (!addr && !images.length) return null;
  const cover = (vd.cover && vd.cover.url_list && vd.cover.url_list[0]) || '';
  return {
    addr, images,
    title: a.desc || '',
    author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
    cover,
    duration: vd.duration || 0,
    likes: (a.statistics && a.statistics.digg_count) || 0,
    createTime: a.create_time || 0
  };
}


async function parseFromPage(finalUrl, diag) {
  let lastErr = null;
  for (const ua of [UA, MOBILE_UA, GOOGLEBOT_UA]) {
    try {
      const r = await parseHtmlWithUA(finalUrl, ua, diag);
      if (r) return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('page no video data');
}

async function parseHtmlWithUA(finalUrl, userAgent, diag) {
  const ck = await getTikTokCookie();
  const resp = await fetchWithTimeout(finalUrl, {
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Cookie': ck || 'tt_webid_v2=0;tt_csrf_token=0'
    }
  }, 9000);
  if (!resp.ok) throw new Error('page HTTP ' + resp.status);
  const html = await resp.text();
  if (!html || html.length < 1000) throw new Error('page too short len=' + (html ? html.length : 0));

  let videoUrl = '', hdVideoUrl = '', images = [], title = '', author = '', cover = '';
  let _dur = 0, _likes = '', _ct = 0;

  // 1. __UNIVERSAL_DATA_FOR_REHYDRATION__
  try {
    const m = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const raw = JSON.parse(m[1]);
      const data = raw?.__DEFAULT_SCOPE__ || raw;
      // TikTok universal 数据的 key 是带点的扁平字符串（如 "webapp.video-detail"），不是嵌套对象
      const v = (data['webapp.video-detail'] || data['webapp.videoDetail'] || data['webapp.reflow.video.detail'] || {}).itemInfo?.itemStruct
             || data?.videoData?.[0] || data?.itemInfo?.itemStruct || data?.itemStruct;
      if (v) {
        const vd = v.video || {};
        const addr = resolveAddr(vd);
        if (addr) { videoUrl = addr; hdVideoUrl = addr; }
        const ip = v.imagePost || {};
        const imgArr = Array.isArray(v.images) ? v.images : (Array.isArray(ip.images) ? ip.images : []);
        if (imgArr.length) {
          images = imgArr.map(i => {
            const o = (i && (i.imageURL || i.imageUrl || i)) || {};
            const list = o.urlList || (o.imageURL && o.imageURL.urlList) || [];
            return list[0] || '';
          }).filter(Boolean);
        }
        title = v.desc || v.title || '';
        author = v.author?.nickname || v.author?.uniqueId || '';
        cover = v.cover || v.originCover || (vd.cover || '') || (ip.cover || '');
        if (v.originCover) cover = v.originCover;
        const vst = v.stats || {};
        _dur = vd.duration || 0;
        _likes = vst.diggCount || vst.digg_count || 0;
        _ct = v.createTime || 0;
      }
    }
  } catch (e) {}

  // 2. SIGI_STATE
  if (!videoUrl && !images.length) {
    try {
      const m = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
      if (m) {
        const data = JSON.parse(m[1]);
        const im = data?.ItemModule || {};
        const ids = Object.keys(im);
        if (ids.length) {
          const v = im[ids[0]];
          const vd = v?.video || {};
          const addr = resolveAddr(vd);
          if (addr) { videoUrl = addr; hdVideoUrl = addr; }
          if (Array.isArray(v?.images)) {
            images = v.images.map(i => i?.imageURL?.urlList?.[0] || '').filter(Boolean);
          }
          if (!title) title = v?.desc || '';
          if (!author) author = v?.author?.nickname || v?.author?.uniqueId || '';
          if (!cover) cover = v?.originCover || v?.cover || (vd?.cover || '');
        }
      }
    } catch (e) {}
  }

  // 3. __NEXT_DATA__
  if (!videoUrl && !images.length) {
    try {
      const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) {
        const data = JSON.parse(m[1]);
        const v = data?.props?.pageProps?.itemInfo?.itemStruct;
        if (v) {
          const vd = v.video || {};
          const addr = vd.playAddr || vd.downloadAddr || '';
          if (typeof addr === 'string' && addr.startsWith('http')) { videoUrl = addr; hdVideoUrl = addr; }
          const _ip = v.imagePost || {};
          const _arr = Array.isArray(v.images) ? v.images : (Array.isArray(_ip.images) ? _ip.images : []);
          if (_arr.length) images = _arr.map(i => (i?.imageURL?.urlList || i?.urlList || [])[0] || '').filter(Boolean);
          if (!title) title = v.desc || '';
          if (!author) author = v.author?.nickname || v.author?.uniqueId || '';
          if (!cover) cover = v.cover || (vd.cover || '');
        }
      }
    } catch (e) {}
  }

  // 3.5 抖音专用直抓（_ROUTER_DATA / __pace_f；TikTok 页面没有这些结构，不影响）
  if (!videoUrl && !images.length) {
    const dy = extractDouyinVideo(html);
    if (dy) {
      if (dy.addr) { videoUrl = dy.addr; hdVideoUrl = dy.addr; }
      if (dy.images && dy.images.length) images = dy.images;
      if (!title) title = dy.title;
      if (!author) author = dy.author;
      if (!cover) cover = dy.cover;
      if (!_dur) _dur = dy.duration || 0;
      if (!_likes) _likes = dy.likes || 0;
      if (!_ct) _ct = dy.createTime || 0;
    }
  }

  // 4. 正则兜底 mp4/m3u8
  if (!videoUrl) {
    const ms = html.match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g) || [];
    const valid = ms.filter(u => u.length > 50 && !u.includes('avatar') && !u.includes('icon'));
    if (valid.length) {
      valid.sort((a, b) => b.length - a.length);
      videoUrl = valid[0]; hdVideoUrl = valid[0];
    }
  }

  if (!videoUrl && !images.length) {
    if (diag) {
      const t = html.match(/<title>([^<]*)<\/title>/);
      const isVerify = /verify|captcha|robot|access denied|just a moment|attention required/i.test(html);
      const hasApp = html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      throw new Error('page no video data html=' + html.length + ' title=' + (t ? t[1].slice(0, 60) : '') + ' verify=' + isVerify + ' universal=' + hasApp);
    }
    throw new Error('page no video data');
  }

  const og = (html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) || [])[1] || '';
  if (!title) title = og;
  if (!cover) cover = (html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/) || [])[1] || '';

  return {
    success: true,
    type: images.length && !videoUrl ? 'photo' : 'video',
    id: extractVideoId(finalUrl) || Date.now(),
    title, author, authorAvatar: '', cover,
    videoUrl, hdVideoUrl: hdVideoUrl || videoUrl, images,
    duration: _dur || 0, likes: _likes || '', createTime: _ct || 0,
    source: 'page'
  };
}

// TikTok cookie 缓存：先抓首页拿 tt_webid/tt_csrf_token，缓解数据中心 IP 的 playAddr 降级
let cookieCache = { value: '', at: 0 };
async function getTikTokCookie() {
  if (cookieCache.value && Date.now() - cookieCache.at < 10 * 60 * 1000) return cookieCache.value;
  try {
    const r = await fetchWithTimeout('https://www.tiktok.com/', { headers: { 'User-Agent': UA } }, 8000);
    const all = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const single = r.headers.get('set-cookie') || '';
    const list = all.length ? all : (single ? [single] : []);
    const parts = list.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
    if (parts) { cookieCache = { value: parts, at: Date.now() }; }
  } catch (e) {}
  return cookieCache.value;
}

// TikTok 官方内部 API 通用查询：item/detail 与 item/get（带 cookie，多区域轮询，
// 缓解 region-lock 视频 playAddr 为空；两个接口互为冗余，提高命中率）
async function parseTiktokOfficial(itemId, apiPath, sourceName) {
  const ck = await getTikTokCookie();
  const REGIONS = ['US', 'SG', 'ID', 'MY', 'HK', 'TW', 'JP'];
  let lastErr = null;
  for (const region of REGIONS) {
    try {
      const resp = await fetchWithTimeout(
        'https://www.tiktok.com' + apiPath + '?itemId=' + itemId + '&aid=1988&app_language=en&device_platform=web_pc&os=windows&region=' + region,
        {
          headers: {
            'User-Agent': UA,
            'Cookie': ck || 'tt_webid_v2=0;tt_csrf_token=0',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'application/json, text/plain, */*'
          }
        }, API_TIMEOUT);
      if (!resp.ok) { lastErr = new Error(sourceName + ' HTTP ' + resp.status); continue; }
      const txt = await resp.text();
      if (!txt || txt.length < 10) { lastErr = new Error(sourceName + ' empty'); continue; }
      const d = JSON.parse(txt);
      const v = d?.itemInfo?.itemStruct || d?.data?.itemInfo?.itemStruct;
      if (v?.id) {
        const vd = v.video || {};
        const addr = resolveAddr(vd);
        const ip = v.imagePost || {};
        const imgArr = Array.isArray(v.images) ? v.images : (Array.isArray(ip.images) ? ip.images : []);
        const images = imgArr.map(i => {
          const o = (i && (i.imageURL || i.imageUrl || i)) || {};
          const list = o.urlList || (o.imageURL && o.imageURL.urlList) || [];
          return list[0] || '';
        }).filter(Boolean);
        if (addr || images.length) {
          return {
            success: true,
            type: images.length && !addr ? 'photo' : 'video',
            id: v.id || Date.now(), title: v.desc || '', author: v.author?.nickname || '',
            authorAvatar: v.author?.avatarLarger || v.author?.avatarThumb || '',
            cover: v.originCover || v.cover || (vd.cover || ''),
            videoUrl: addr, hdVideoUrl: addr,
            images, duration: vd.duration || 0,
            likes: (v.stats && (v.stats.diggCount || v.stats.digg_count)) || 0,
            createTime: v.createTime || 0, source: sourceName
          };
        }
        lastErr = new Error(sourceName + ' no addr (region=' + region + ')');
      } else {
        lastErr = new Error(sourceName + ' no struct');
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(sourceName + ' no data');
}
async function parseViaItemDetail(itemId) { return parseTiktokOfficial(itemId, '/api/item/detail/', 'tiktok-item-detail'); }
async function parseViaItemGet(itemId) { return parseTiktokOfficial(itemId, '/api/item/get/', 'tiktok-item-get'); }

// 第三方解析源（Worker 海外访问，不受国内网络限制）
function buildApiSources(enc, itemId) {
  return [
    {
      name: 'tikwm.com', url: `https://www.tikwm.com/api/?url=${enc}&hd=1`,
      parse: (d) => {
        if (d?.code === 0 && d?.data) {
          const x = d.data;
          return {
            success: true, type: (x.images && x.images.length && !x.play) ? 'photo' : 'video',
            id: x.id || Date.now(), title: x.title || '', author: x.author?.nickname || '',
            authorAvatar: x.author?.avatar || '', cover: x.cover || '',
            videoUrl: (x.play || '').trim(), hdVideoUrl: (x.hdplay || x.play || '').trim(),
            images: Array.isArray(x.images) ? x.images.map(i => typeof i === 'string' ? i : (i?.url || '')).filter(Boolean) : [],
            duration: x.duration || 0, likes: x.digg_count || 0, createTime: x.create_time || 0,
            source: 'tikwm.com'
          };
        }
        return null;
      }
    },
    {
      name: 'api.tikwm.com', url: `https://api.tikwm.com/api/?url=${enc}&hd=1`,
      parse: (d) => {
        if (d?.code === 0 && d?.data) {
          const x = d.data;
          return {
            success: true, type: (x.images && x.images.length && !x.play) ? 'photo' : 'video',
            id: x.id || Date.now(), title: x.title || '', author: x.author?.nickname || '',
            authorAvatar: x.author?.avatar || '', cover: x.cover || '',
            videoUrl: (x.play || '').trim(), hdVideoUrl: (x.hdplay || x.play || '').trim(),
            images: Array.isArray(x.images) ? x.images.map(i => typeof i === 'string' ? i : (i?.url || '')).filter(Boolean) : [],
            duration: x.duration || 0, likes: x.digg_count || 0, createTime: x.create_time || 0,
            source: 'api.tikwm.com'
          };
        }
        return null;
      }
    },
    {
      name: 'tiklydown.eu.org', url: `https://api.tiklydown.eu.org/api/download?url=${enc}`,
      parse: (d) => {
        if ((d?.status === 'success' || d?.code === 200) && (d?.data || d?.result)) {
          const x = d.data || d.result;
          const v = x.video || x;
          const play = v.play || v.noWatermark || v.url || v.hdplay || '';
          const imgs = Array.isArray(x.images) ? x.images.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
          if (play || imgs.length) {
            return {
              success: true, type: play ? 'video' : 'photo',
              id: x.id || x.aweme_id || x.video_id || Date.now(), title: x.title || x.desc || '',
              author: x.author?.nickname || x.authorInfo?.nickname || x.author?.unique_id || '',
              authorAvatar: x.author?.avatar || x.authorInfo?.avatar || '', cover: x.cover || v.cover || '',
              videoUrl: play.trim(), hdVideoUrl: (v.hdplay || v.noWatermark || play || '').trim(),
              images: imgs, duration: v.duration || 0, likes: x.digg_count || x.likes || 0,
              createTime: x.create_time || 0, source: 'tiklydown.eu.org'
            };
          }
        }
        return null;
      }
    },
    {
      name: 'tikmate.app', url: `https://api.tikmate.app/api/v1/fetch?url=${enc}`,
      parse: (d) => {
        if (d?.success && d?.data) {
          const x = d.data;
          const play = x.play || x.video_url || '';
          const imgs = Array.isArray(x.images) ? x.images.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
          if (play || imgs.length) {
            return {
              success: true, type: play ? 'video' : 'photo',
              id: x.id || x.video_id || Date.now(), title: x.title || x.description || '',
              author: x.author?.nickname || x.author_name || '', authorAvatar: x.author?.avatar || '',
              cover: x.cover || x.thumbnail || '', videoUrl: play.trim(),
              hdVideoUrl: (x.hdplay || x.hd_video_url || play || '').trim(),
              images: imgs, duration: x.duration || 0, likes: x.digg_count || x.likes || 0,
              createTime: x.create_time || 0, source: 'tikmate.app'
            };
          }
        }
        return null;
      }
    },
    {
      name: 'tdownv4.workers.dev', url: `https://tdownv4.sl-bjs.workers.dev/?down=${enc}`,
      parse: (d) => {
        if (d?.download_url) {
          return {
            success: true, type: 'video', id: d.video_id || Date.now(),
            title: d.title || '', author: d.author?.nickname || d.author?.username || '',
            authorAvatar: d.author?.avatar || '', cover: d.cover || '',
            videoUrl: d.download_url.trim(), hdVideoUrl: d.download_url.trim(),
            images: [], duration: d.duration || 0, likes: d.author?.like_count || 0,
            createTime: 0, source: 'tdownv4'
          };
        }
        return null;
      }
    },
    {
      name: 'douyin.wtf', url: `https://api.douyin.wtf/api/hybrid/video_data?url=${enc}&minimal=false`,
      parse: (d) => {
        if (d?.code === 200 && d?.data) {
          const x = d.data.video_data || d.data;
          const play = x.play || x.play_addr || x.video_url || '';
          const imgs = Array.isArray(x.images) ? x.images.map(i => typeof i === 'string' ? i : (i?.url || i?.urlList?.[0] || '')).filter(Boolean) : [];
          if (play || imgs.length) {
            return {
              success: true, type: play ? 'video' : 'photo',
              id: x.vid || x.aweme_id || x.id || Date.now(), title: x.desc || x.title || '',
              author: d.data.author?.nickname || x.author?.nickname || '',
              authorAvatar: d.data.author?.avatar || x.author?.avatar || '',
              cover: x.cover || '', videoUrl: play.trim(),
              hdVideoUrl: (x.hdplay || play || '').trim(), images: imgs,
              duration: x.duration || 0, likes: x.statistics?.digg_count || 0,
              createTime: x.create_time || 0, source: 'douyin.wtf'
            };
          }
        }
        return null;
      }
    }
  ];
}

// 并行竞速 + 降级：页面直抓 + TikTok 官方接口 + 全部第三方源。
// mode：all=全部策略；html=只跑页面直抓；api=只跑第三方源；item=只跑 TikTok 官方接口
async function parseViaSources(finalUrl, diag, mode) {
  mode = mode || 'all';
  const errors = [];
  const enc = encodeURIComponent(finalUrl);
  const itemId = extractVideoId(finalUrl) || '';
  const apis = buildApiSources(enc, itemId).filter(s => !sourceInCooldown(s.name));
  const runPage = mode === 'all' || mode === 'html';
  const runApis = mode === 'all' || mode === 'api';
  const runItem = mode === 'all' || mode === 'item';
  const sources = [];

  if (runPage) {
    sources.push(parseFromPage(finalUrl, diag).then(r => { recordSource('page', true); return r; }).catch(e => {
      recordSource('page', false);
      if (diag) errors.push('page: ' + e.message);
      throw e;
    }));
  }
  if (runItem && itemId) {
    for (const [name, fn] of [['tiktok-item-detail', () => parseViaItemDetail(itemId)],
                              ['tiktok-item-get', () => parseViaItemGet(itemId)]]) {
      sources.push(fn().then(r => { recordSource(name, true); return r; }).catch(e => {
        recordSource(name, false);
        if (diag) errors.push(name + ': ' + e.message);
        throw e;
      }));
    }
  }
  if (runApis) {
    for (const s of apis) {
      sources.push((async () => {
        try {
          const resp = await fetchWithTimeout(s.url, { headers: { 'User-Agent': UA } }, API_TIMEOUT);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          const r = s.parse(data);
          if (!r || !r.success) throw new Error('parse fail');
          recordSource(s.name, true);
          return r;
        } catch (e) {
          recordSource(s.name, false);
          if (diag) errors.push(s.name + ': ' + e.message);
          throw e;
        }
      })());
    }
  }

  if (!sources.length) {
    const err = new Error('no source for mode=' + mode);
    err.diag = errors;
    throw err;
  }

  try {
    return await Promise.race([
      Promise.any(sources),
      new Promise((_, reject) => setTimeout(() => reject(new Error('total timeout')), TOTAL_PARSE_TIMEOUT))
    ]);
  } catch (e) {
    // 全部失败：逐个降级（跳过冷却源）——仅 api 模式/全量模式下有第三方源可降级
    if (runApis) {
      for (const s of apis) {
        if (sourceInCooldown(s.name)) continue;
        try {
          const resp = await fetchWithTimeout(s.url, { headers: { 'User-Agent': UA } }, 3000);
          if (!resp.ok) { if (diag) errors.push(s.name + ' [fallback]: HTTP ' + resp.status); continue; }
          const r = s.parse(await resp.json());
          if (r?.success) { recordSource(s.name, true); return r; }
          recordSource(s.name, false);
          if (diag) errors.push(s.name + ' [fallback]: parse fail');
        } catch (e2) {
          recordSource(s.name, false);
          if (diag) errors.push(s.name + ' [fallback]: ' + e2.message);
        }
      }
    }
    const err = new Error('all sources failed');
    err.diag = errors;
    throw err;
  }
}

async function handleParse(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method not allowed' }, 405, corsHeaders());
  }
  const url = new URL(request.url);
  if (!checkToken(url)) return jsonResponse({ error: 'invalid token' }, 401, corsHeaders());

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return jsonResponse({ error: 'rate limited' }, 429, corsHeaders());

  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse({ error: 'missing url' }, 400, corsHeaders());
  const finalUrl = normalizeUrl(raw);
  if (!/tiktok\.com|douyin\.com|iesdouyin\.com|tiktokv\.com|vm\.tiktok|v\.douyin/i.test(finalUrl)) {
    return jsonResponse({ error: 'not a tiktok/douyin link' }, 400, corsHeaders());
  }

  // 短链接在 Worker 端展开
  let target = finalUrl;
  if (/vm\.tiktok\.com|v\.douyin\.com/i.test(finalUrl)) {
    try {
      const r = await fetchWithTimeout(finalUrl, { method: 'GET', redirect: 'follow' }, 6000);
      target = normalizeUrl(r.url || finalUrl);
    } catch (e) {}
  }

  try {
    const diag = url.searchParams.get('diag') === '1';
    const mode = url.searchParams.get('mode') || 'all';
    const result = await parseViaSources(target, diag, mode);
    return jsonResponse(result, 200, corsHeaders());
  } catch (e) {
    const body = { success: false, error: e.message || 'parse failed' };
    if (e.diag && Array.isArray(e.diag)) body.diag = e.diag;
    return jsonResponse(body, 200, corsHeaders());
  }
}

// ============================================================
//  诊断端点 /api/diag-page（仅调试用，token 保护）
// ============================================================
async function handleDiagPage(request) {
  const url = new URL(request.url);
  if (!checkToken(url)) return jsonResponse({ error: 'invalid token' }, 401);
  const raw = url.searchParams.get('url');
  if (!raw) return jsonResponse({ error: 'missing url' }, 400);
  const finalUrl = normalizeUrl(raw);
  try {
    const resp = await fetchWithTimeout(finalUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
      }
    }, 9000);
    const html = await resp.text();
    const info = {
      status: resp.status, htmlLen: html.length,
      hasUniversal: html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
      hasSIGI: html.includes('SIGI_STATE'),
      hasNext: html.includes('__NEXT_DATA__'),
      title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
    };
    // 页面中的图片 URL 线索（图集 SSR 直出场景）
    const imgUrls = html.match(/https?:\/\/[^"'\s\\]+\.(?:jpe?g|webp|png)[^"'\s\\]*/g) || [];
    info.imgUrlCount = imgUrls.length;
    info.imgUrlSample = imgUrls.slice(0, 5).map(u => u.slice(0, 130));
    // 移动端 UA 变体
    const mRes = await fetchWithTimeout(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, 9000);
    const mHtml = await mRes.text();
    info.mobileStatus = mRes.status;
    info.mobileLen = mHtml.length;
    info.mobileUniversal = mHtml.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    info.mobileSIGI = mHtml.includes('SIGI_STATE');
    info.mobileImgUrlCount = (mHtml.match(/https?:\/\/[^"'\s\\]+\.(?:jpe?g|webp|png)[^"'\s\\]*/g) || []).length;
    // 移动端 universal 结构
    const mIdx = mHtml.indexOf('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (mIdx >= 0) {
      const mScriptStart = mHtml.lastIndexOf('<script', mIdx);
      const mContentStart = mHtml.indexOf('>', mScriptStart) + 1;
      const mScriptEnd = mHtml.indexOf('</script>', mContentStart);
      const mRaw = mHtml.slice(mContentStart, mScriptEnd);
      info.mobileRawLen = mRaw.length;
      try {
        const mp = JSON.parse(mRaw);
        const mScope = mp.__DEFAULT_SCOPE__ || mp;
        info.mobileScopeKeys = Object.keys(mScope).slice(0, 25);
        const mI = mRaw.indexOf('itemStruct');
        if (mI >= 0) info.mobileItemStructCtx = mRaw.slice(Math.max(0, mI - 200), mI + 1600);
        try {
          const mvd = mScope['webapp.reflow.video.detail'] || {};
          const mS = (mvd.itemInfo || {}).itemStruct || {};
          info.mobileItemStructKeys = Object.keys(mS).slice(0, 30);
          info.mobileVideoKeys = mS.video ? Object.keys(mS.video).slice(0, 25) : null;
          info.mobilePlayAddr = mS.video ? String(mS.video.playAddr || '').slice(0, 160) : null;
          info.mobileDownloadAddr = mS.video ? String(mS.video.downloadAddr || '').slice(0, 160) : null;
          const imgCand = mS.images || mS.imagePost || mS.imageList || null;
          info.mobileImgCand = imgCand ? JSON.stringify(imgCand).slice(0, 500) : null;
        } catch (e) { info.mobileStructErr = e.message; }
        const mIm = mRaw.indexOf('"images"');
        if (mIm >= 0) info.mobileImagesCtx = mRaw.slice(Math.max(0, mIm - 400), mIm + 800);
        const mIp = mRaw.indexOf('imagePost');
        if (mIp >= 0) info.mobileImagePostCtx = mRaw.slice(Math.max(0, mIp - 200), mIp + 800);
      } catch (e) {
        info.mobileParseError = e.message;
      }
    }
    const idx = html.indexOf('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (idx >= 0) {
      const scriptStart = html.lastIndexOf('<script', idx);
      const contentStart = html.indexOf('>', scriptStart) + 1;
      const scriptEnd = html.indexOf('</script>', contentStart);
      const rawJson = html.slice(contentStart, scriptEnd);
      info.rawLen = rawJson.length;
      info.sampleHead = rawJson.slice(0, 300);
      try {
        const p = JSON.parse(rawJson);
        info.parseOk = true;
        const scope = p.__DEFAULT_SCOPE__ || p;
        info.topKeys = Object.keys(p).slice(0, 12);
        info.scopeKeys = Object.keys(scope).slice(0, 25);
        // 定位 itemStruct / images / imagePost 实际出现的上下文
        const mark = (name, needle) => {
          const i = rawJson.indexOf(needle);
          if (i >= 0) info[name] = rawJson.slice(Math.max(0, i - 260), i + 320);
        };
        mark('itemStructCtx', 'itemStruct');
        mark('imagesCtx', '"images"');
        mark('imagePostCtx', 'imagePost');
        mark('postCtx', '"post"');
        // 每个 scope key 的类型与头部摘要（定位图集数据实际所在）
        info.scopeDetail = Object.keys(scope).map(k => {
          const v = scope[k];
          const t = Array.isArray(v) ? 'array' : typeof v;
          let head = '';
          if (t === 'object') head = '{' + Object.keys(v).slice(0, 12).join(',') + '}';
          else if (t === 'array') head = '[' + (v[0] !== undefined ? (Array.isArray(v[0]) ? 'array' : typeof v[0]) : '') + '...x' + v.length + ']';
          else head = String(v).slice(0, 80);
          return k + ':' + t + ' ' + head;
        }).slice(0, 15);
        const w = scope.webapp;
        if (w) {
          info.webappKeys = Object.keys(w).slice(0, 25);
          if (w.videoDetail) {
            info.videoDetailKeys = Object.keys(w.videoDetail).slice(0, 15);
            const s = w.videoDetail.itemInfo && w.videoDetail.itemInfo.itemStruct;
            if (s) {
              info.itemStructKeys = Object.keys(s).slice(0, 30);
              info.videoKeys = s.video ? Object.keys(s.video).slice(0, 25) : null;
              info.playAddr = s.video && s.video.playAddr ? String(s.video.playAddr).slice(0, 120) : null;
              info.bitrate0 = s.video && s.video.bitrateInfo && s.video.bitrateInfo[0] ? Object.keys(s.video.bitrateInfo[0]) : null;
              info.imagesLen = Array.isArray(s.images) ? s.images.length : null;
            }
          }
        }
      } catch (e) {
        info.parseOk = false;
        info.parseError = e.message;
        info.sampleTail = rawJson.slice(-300);
      }
    }
    return jsonResponse(info, 200);
  } catch (e) {
    return jsonResponse({ error: 'diag failed: ' + e.message }, 502);
  }
}

// ============================================================
//  视频流代理 /api/proxy
// ============================================================
async function handleProxy(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method not allowed' }, 405, corsHeaders());
  }
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return jsonResponse({ error: 'missing url param' }, 400, corsHeaders());
  }
  let t;
  try { t = new URL(target); } catch (e) {
    return jsonResponse({ error: 'invalid url' }, 400, corsHeaders());
  }
  if ((t.protocol !== 'https:' && t.protocol !== 'http:') || !hostAllowed(t.hostname)) {
    return jsonResponse({ error: 'domain not allowed' }, 403, corsHeaders());
  }
  try {
    let upstream = null;
    // UA 轮询 + cookie 刷新：TikTok CDN 对数据中心 IP/UA 特征风控，逐个组合尝试
    for (let i = 0; i < PROXY_UAS.length && !upstream; i++) {
      let ck = await getTikTokCookie();
      const fetchUp = async (ckv) => {
        return fetch(t.href, {
          headers: {
            'User-Agent': PROXY_UAS[i],
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'video/mp4, video/*;q=0.9, */*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cookie': ckv || '',
            'Range': request.headers.get('Range') || ''
          },
          redirect: 'follow'
        });
      };
      let r = await fetchUp(ck);
      // 403/406（cookie 失效或风控波动）：强制刷新 cookie 重试一次
      if (r.status === 403 || r.status === 406) {
        cookieCache = { value: '', at: 0 };
        ck = await getTikTokCookie();
        r = await fetchUp(ck);
      }
      if (r.ok || r.status === 206) upstream = r;
    }
    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
    headers.set('Content-Disposition', 'attachment; filename="tiktok-download.mp4"');
    return new Response(upstream.body, { status: upstream.status, headers: headers });
  } catch (e) {
    return jsonResponse({ error: 'proxy fetch failed' }, 502, corsHeaders());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse' || url.pathname.startsWith('/api/parse')) {
      return handleParse(request);
    }
    if (url.pathname === '/api/diag-page' || url.pathname.startsWith('/api/diag-page')) {
      return handleDiagPage(request);
    }
    if (url.pathname === '/api/proxy' || url.pathname.startsWith('/api/proxy')) {
      return handleProxy(request);
    }
    return env.ASSETS.fetch(request);
  }
};
