// TikTok/抖音下载器 - Content Script
// 监听推荐页视频切换，自动通知后台解析

let lastParsedVideoId = null;
let observer = null;
let isEnabled = false;

// 从 chrome.storage 读取开关状态（默认关闭，只有用户显式打开“推荐页滑动自动解析”才收集）
chrome.storage.local.get('recommendAutoParse', (result) => {
  isEnabled = result.recommendAutoParse === true;
  if (isEnabled && isAutoParsePage()) {
    initObserver();
  }
});

// 监听开关变化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recommendAutoParse) {
    isEnabled = changes.recommendAutoParse.newValue === true;
    if (isEnabled && isAutoParsePage() && !observer) {
      initObserver();
    } else if (!isEnabled && observer) {
      observer.disconnect();
      observer = null;
    }
  }
});

// 判断当前页面是否可自动解析（推荐页 / 搜索页 / 标签页 / 用户主页）
function isAutoParsePage() {
  const host = location.hostname;
  if (!host.includes('tiktok.com') && !host.includes('douyin.com')) return false;
  const path = location.pathname;
  // TikTok：推荐页（/、/foryou、区域页）+ 搜索页 + 标签页 + 用户主页
  if (host.includes('tiktok.com')) {
    return /^\/(?:[a-z]{2}\/)?(?:foryou)?$/.test(path)
        || path.startsWith('/search')
        || path.startsWith('/tag/')
        || path.startsWith('/@');
  }
  // 抖音：首页 + 搜索页 + 用户主页
  if (host.includes('douyin.com')) {
    return path === '/' || path === '' || /^\/(?:[a-z]{2}\/)?$/.test(path)
        || path.startsWith('/search')
        || path.startsWith('/user/');
  }
  return false;
}

// 检测当前正在播放的视频元素，提取 videoId
function getCurrentPlayingVideoId() {
  // 优先找正在播放的 video 元素
  const videos = document.querySelectorAll('video');
  let playingVideo = null;
  
  for (const v of videos) {
    if (!v.paused && v.currentTime > 0 && !v.ended) {
      playingVideo = v;
      break;
    }
  }
  // 没找到正在播放的，取第一个 video
  if (!playingVideo && videos.length > 0) {
    playingVideo = videos[0];
  }
  if (!playingVideo) return null;

  // 向上遍历父容器，寻找包含 /video/xxx 的 a 标签
  let node = playingVideo;
  for (let i = 0; i < 15; i++) {
    node = node.parentElement;
    if (!node) break;
    // 直接在容器里找 a 标签
    const link = node.querySelector('a[href*="/video/"]');
    if (link?.href) {
      const match = link.href.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }
    // 容器本身是 a 标签
    if (node.tagName === 'A' && node.href?.includes('/video/')) {
      const match = node.href.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }
  }

  // 兜底：从页面所有 /video/ 链接中找在视口中的
  const links = document.querySelectorAll('a[href*="/video/"]');
  for (const link of links) {
    const rect = link.getBoundingClientRect();
    if (rect.top >= -100 && rect.bottom <= window.innerHeight + 100 && rect.width > 0) {
      const match = link.href.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }
  }

  return null;
}

// 获取当前视频信息（videoId + 作者），供推荐页自动解析与"当前页"抓取使用
function getCurrentVideoInfo() {
  const videoId = getCurrentPlayingVideoId();
  if (!videoId) return null;
  // 从页面中查找作者信息（链接格式 /@username/video/xxx）
  let author = '';
  const links = document.querySelectorAll('a[href*="/video/"]');
  for (const link of links) {
    if (link.href && link.href.includes('/video/' + videoId)) {
      const m = link.href.match(/\/@([^\/?]+)\//);
      if (m) { author = m[1]; break; }
    }
  }
  return { videoId, author };
}

// DOM 变动回调
function onDomMutate() {
  if (!isEnabled || !isAutoParsePage()) return;
  const info = getCurrentVideoInfo();
  if (!info?.videoId) return;
  if (info.videoId === lastParsedVideoId) return;
  lastParsedVideoId = info.videoId;
  
  // 通知后台，提交解析任务
  try {
    chrome.runtime.sendMessage({
      type: 'recommend-auto-parse',
      videoId: info.videoId,
      author: info.author,
      pageUrl: location.href
    });
  } catch (e) {
    // SW 可能休眠，忽略错误
  }
}

// 启动 MutationObserver
function initObserver() {
  if (observer) return;
  observer = new MutationObserver(onDomMutate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false
  });
  
  // 启动时立即检测一次
  onDomMutate();
}

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

});

// 监听来自 popup 的消息（比如立即检测当前视频）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'detect-current-video') {
    const info = getCurrentVideoInfo();
    sendResponse({ videoId: info?.videoId, author: info?.author, pageUrl: location.href });
    return true;
  }
});
