// TikTok / Douyin 无水印下载器 - 网页版高级模式 Worker（Cloudflare Pages Advanced Mode）
// 部署：作为 web/_worker.js 与静态资源一起上传到 Pages。
// 功能：
//   - /api/proxy?url=<视频地址>  服务端转发视频流并附加 CORS 头，实现"点击直接下载"
//   - 其余路径                    回退到静态资源（index.html 等）
// 安全：只允许代理 TikTok / 抖音视频 CDN 域名，防止被当开放代理滥用。

const ALLOWED = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-cn.com', 'tiktokv.com',
  'douyinvod.com', 'zjcdn.com', 'douyin.com', 'iesdouyin.com',
  'amemv.com', 'bytecdn.cn', 'volccdn.com', 'byteimg.com', 'gstatic.com'
];

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
  return ALLOWED.some(function (d) { return h === d || h.endsWith('.' + d); });
}

function jsonResponse(body, status, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
  return new Response(JSON.stringify(body), { status: status, headers: h });
}

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
    const upstream = await fetch(t.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Referer': t.origin + '/',
        'Accept': 'video/mp4, video/*;q=0.9, */*;q=0.8',
        'Range': request.headers.get('Range') || ''
      },
      redirect: 'follow'
    });
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
    if (url.pathname === '/api/proxy' || url.pathname.startsWith('/api/proxy')) {
      return handleProxy(request);
    }
    // 其余请求回退到静态资源
    return env.ASSETS.fetch(request);
  }
};
