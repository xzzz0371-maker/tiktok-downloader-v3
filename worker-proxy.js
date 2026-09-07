// TikTok / Douyin 无水印下载器 - 视频流代理 Worker
// 用途：网页版前端受浏览器跨域(CORS)限制无法直接下载跨域视频，
// 此 Worker 在服务端转发视频流并附加 CORS 头，使网页版可以实现"点击直接下载"。
// 部署：npx wrangler@3 deploy worker-proxy.js --name tiktok-downloader-proxy

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
  };
}

export default {
  async fetch(request) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('{"error":"missing url param"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 只允许 http/https
    let t;
    try { t = new URL(target); } catch (e) {
      return new Response('{"error":"invalid url"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
    if (t.protocol !== 'https:' && t.protocol !== 'http:') {
      return new Response('{"error":"unsupported protocol"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
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

      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response('{"error":"proxy fetch failed"}', {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};
