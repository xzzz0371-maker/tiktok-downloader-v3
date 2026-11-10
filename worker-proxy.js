// TikTok / Douyin 无水印下载器 - 视频流代理 Worker
// 用途：网页版前端受浏览器跨域(CORS)限制无法直接下载跨域视频，
// 此 Worker 在服务端转发视频流并附加 CORS 头，使网页版可以实现"点击直接下载"。
// 部署：npx wrangler@3 deploy worker-proxy.js --name tiktok-downloader-proxy
//
// 安全：与 web/_worker.js 的 /api/proxy 保持一致的策略：
//   - 目标域名白名单（防开放代理滥用）
//   - 仅允许 GET/HEAD（OPTIONS 为 CORS 预检）
//   - 手动跟随重定向并逐跳校验域名（防白名单域名跳转到任意地址）
//   - 只透传少量安全响应头，不透传 Set-Cookie 等 hop-by-hop 头

const ALLOWED = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-cn.com', 'tiktokcdn-eu.com', 'tiktokcdn-in.com',
  'tiktokv.com', 'webapp-prime.tiktok.com',
  'douyinvod.com', 'zjcdn.com', 'douyin.com', 'iesdouyin.com', 'douyinpic.com', 'douyinstatic.com',
  'amemv.com', 'bytecdn.cn', 'volccdn.com', 'byteimg.com', 'muscdn.com', 'ibytedtos.com'
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
  };
}

// IP 限流：每 IP 每分钟 40 次。
// 单次下载只产生 1 个长连接请求，所以正常使用（含并发批量）不会接近该阈值；
// 它的作用是避免本代理被当作无限额度的免费中转刷爆账号带宽。
// 注意：本 Worker 未做鉴权（调用方未统一传 token），因此限流是当前唯一防线。
const HITS_PER_MIN = 40;
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(ts => now - ts < 60000);
  if (arr.length >= HITS_PER_MIN) { ipHits.set(ip, arr); return true; }
  arr.push(now);
  ipHits.set(ip, arr);
  return false;
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  // TikTok webapp-prime CDN：v16-webapp-prime.tiktok.com 等（连字符结构，非子域名）
  if (h === 'webapp-prime.tiktok.com' || h.endsWith('-webapp-prime.tiktok.com')) return true;
  return ALLOWED.some(d => h === d || h.endsWith('.' + d));
}

function errorJson(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// 手动跟随重定向并逐跳校验（fetch 的 redirect:'follow' 不会再校验白名单）
async function fetchChecked(target, headers) {
  let current = target;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(current, { headers, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      let next;
      try { next = new URL(loc, current); } catch (e) { return errorJson('invalid redirect location', 400); }
      if ((next.protocol !== 'https:' && next.protocol !== 'http:') || !hostAllowed(next.hostname)) {
        return errorJson('redirect to non-allowlisted domain blocked', 403);
      }
      current = next.href;
      continue;
    }
    return resp;
  }
  return errorJson('too many redirects', 502);
}

export default {
  async fetch(request) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    // 只允许 GET / HEAD，其余方法一律拒绝（避免被当作任意方法的开放代理）
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorJson('method not allowed', 405);
    }

    // IP 限流（防止被当作免费中转刷爆带宽配额）
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return errorJson('rate limited', 429);
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return errorJson('missing url param', 400);

    // 只允许 http/https 且目标域名必须命中白名单
    let t;
    try { t = new URL(target); } catch (e) { return errorJson('invalid url', 400); }
    if ((t.protocol !== 'https:' && t.protocol !== 'http:') || !hostAllowed(t.hostname)) {
      return errorJson('domain not allowed', 403);
    }

    try {
      // 只在客户端确实带了 Range 时才转发；无条件设置 'Range': '' 会发出非法的空 Range 头
      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Referer': t.origin + '/',
        'Accept': 'video/mp4, video/*;q=0.9, */*;q=0.8'
      };
      const clientRange = request.headers.get('Range');
      if (clientRange) reqHeaders['Range'] = clientRange;
      const upstream = await fetchChecked(t.href, reqHeaders);

      // 只透传少量安全响应头；不透传 Set-Cookie / hop-by-hop 头
      const headers = new Headers(corsHeaders());
      const SAFE = ['content-type', 'content-length', 'content-range', 'accept-ranges',
                    'cache-control', 'content-encoding', 'etag', 'last-modified', 'expires'];
      for (const name of SAFE) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set('Content-Disposition', 'attachment; filename="tiktok-download.mp4"');

      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return errorJson('proxy fetch failed', 502);
    }
  }
};
