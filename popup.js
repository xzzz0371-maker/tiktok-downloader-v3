// ============================================================
// TikTok/抖音下载器 v4.0 - Popup UI
// 新增：下载进度条、卡片下载状态、拦截/深度解析源标识
// v3.1：公共函数抽离、下载速度显示、下载历史标记
// v3.2：深度解析增强、FetchHTML解析、主动抓取、新源标签
// v4.0：移除试用/激活码/每日限额，全免费、无限下载
// ============================================================

// ---------- DOM ----------
const urlInput = document.getElementById('urlInput');
const parseBtn = document.getElementById('parseBtn');
const clearBtn = document.getElementById('clearBtn');
const grabBtn = document.getElementById('grabBtn');
const stopParseBtn = document.getElementById('stopParseBtn');
const recommendAutoParseToggle = document.getElementById('recommendAutoParse');
const videoList = document.getElementById('videoList');
const toast = document.getElementById('toast');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const themeToggle = document.getElementById('themeToggle');
const openWindowBtn = document.getElementById('openWindowBtn');
const bringToFrontBtn = document.getElementById('bringToFrontBtn');
const sidePanelBtn = document.getElementById('sidePanelBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusMessage = document.getElementById('statusMessage');
const resultToolbar = document.getElementById('resultToolbar');
const videoCount = document.getElementById('videoCount');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const skipDownloadedCheckbox = document.getElementById('skipDownloaded');
const historyToolbar = document.getElementById('historyToolbar');
const downloadedCount = document.getElementById('downloadedCount');
const exportHistoryBtn = document.getElementById('exportHistoryBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const previewModal = document.getElementById('previewModal');
const previewVideo = document.getElementById('previewVideo');
const previewClose = document.getElementById('previewClose');
const previewOverlay = document.getElementById('previewOverlay');
const previewTitle = document.getElementById('previewTitle');
const previewAuthor = document.getElementById('previewAuthor');

let parsedVideos = [];
let currentTheme = 'auto';

// 尽早应用记忆主题（applyTheme 是函数声明，可提升调用）：popup.html 首屏内联脚本
// 已按 localStorage 打了 force-* 类防闪烁，这里在 DOMContentLoaded 之前再同步一次，
// 保证 JS 状态（themeToggle 图标等）与配色一致。
try {
  const storedTheme = localStorage.getItem('td_theme');
  if (storedTheme === 'dark' || storedTheme === 'light') applyTheme(storedTheme);
} catch (e) {}

// 当前下载进度映射：videoId -> { state, bytesReceived, totalBytes, percent }
let currentDownloads = {};

// 已下载的视频 ID 集合（用于标记和去重）
let downloadedIds = new Set();

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(s) {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
  return (bytes / 1073741824).toFixed(2) + 'GB';
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + 'B/s';
  if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + 'KB/s';
  return (bytesPerSec / 1048576).toFixed(2) + 'MB/s';
}
// HTML 转义，防止 XSS
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 属性值转义：引号也要转义，防止从属性中逃逸（escapeHtml 不会转义文本节点里的引号）
function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- 缓存 ----------
async function saveCache(videos) {
  await chrome.storage.local.set({ cachedVideos: videos });
}

async function loadCache() {
  const result = await chrome.storage.local.get('cachedVideos');
  return normalizeVideos(result.cachedVideos || []);
}

// 历史缓存里的 id 可能是 number（TikTok id 常超过 2^53，作为数字会丢精度），
// 统一成字符串，否则与 dataset / downloadedIds / 去重 / 进度映射比较全部失效。
function normalizeVideos(list) {
  return (list || []).map(v => v && {
    ...v,
    id: v.id == null || v.id === '' ? String(Date.now()) : String(v.id)
  });
}

// ---------- 状态 ----------
async function updateStatus() {
  statusBadge.textContent = '🎉 免费版';
  statusBadge.style.background = 'var(--success-glow)';
  statusBadge.style.color = 'var(--success)';
  statusText.innerHTML = '♾️ 免费 · 无限下载';
}

// ---------- 解析源标签 ----------
function getSourceLabel(source) {
  const map = {
    'intercept': '⚡拦截',
    'universal': '🔍原画质',
    'sigi': '🔍原画质',
    'window': '🔍原画质',
    'video_tag': '🎬标签',
    'source_tag': '🎬标签',
    'performance': '📊性能',
    'script_regex': '📝正则',
    'script_field': '📝字段',
    'fetch_universal': '📄网页',
    'fetch_sigi': '📄网页',
    'fetch_next': '📄网页',
    'fetch_field': '📄网页',
    'fetch_regex': '📄正则',
    'third_party': '🌐API'
  };
  return map[source] || '';
}

// ---------- 渲染卡片 ----------
function renderCard(video, index) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.index = index;
  card.dataset.videoId = video.id || '';

  if (!video.success) {
    card.innerHTML = `
      <div class="cover" style="display:flex;align-items:center;justify-content:center;font-size:20px;color:#ff3b30;">✕</div>
      <div class="info">
        <button class="btn-delete-corner" data-del="${index}">✕</button>
        <div class="title" style="color:#ff3b30;">解析失败</div>
        <div class="meta">${video.error || ''}</div>
      </div>
      <div class="actions"></div>
    `;
    card.querySelector('.btn-delete-corner')?.addEventListener('click', (e) => {
      e.stopPropagation();
      // 用实时的 dataset.index（列表头部插入新卡后索引会重排）
      deleteVideo(Number(card.dataset.index));
    });
    videoList.appendChild(card);
    return;
  }

  const dur = formatDuration(video.duration);
  const sizeStr = video.fileSize ? formatFileSize(video.fileSize) : '';
  const safeTitle = escapeHtml(video.title);
  const safeAuthor = escapeHtml(video.author);
  const safeCover = escapeAttr((video.cover && /^https?:\/\//i.test(video.cover)) ? video.cover : '');
  const langLabel = video.language ? `🌐 ${escapeHtml(video.language)}` : '';
  const likesLabel = video.likes ? `❤️ ${escapeHtml(video.likes)}` : '';
  const dateLabel = video.createTime ? `📅 ${escapeHtml(video.createTime)}` : '';
  const sourceLabel = getSourceLabel(video._parseSource);
  const qualityLabel = (video.type === 'photo' || (video.images && video.images.length))
    ? '🖼 图集 ' + (video.images ? video.images.length : 0) + ' 张'
    : (video.quality || '高清');

  card.innerHTML = `
    <div class="cover" data-preview="${index}" style="cursor:pointer;">
      <img src="${safeCover}" onerror="this.style.display='none'">
      ${dur ? `<div class="dur">${dur}</div>` : ''}
      ${sourceLabel ? `<div class="source-badge">${sourceLabel}</div>` : ''}
    </div>
    <div class="info">
      <button class="btn-delete-corner" data-del="${index}">✕</button>
      <div class="title" data-preview="${index}" title="${escapeAttr(video.title)}">${safeTitle}</div>
      <div class="meta">
        <span class="author">👤 ${safeAuthor}</span>
        <span class="quality">${escapeHtml(qualityLabel)}</span>
        ${langLabel ? `<span>${langLabel}</span>` : ''}
        ${likesLabel ? `<span>${likesLabel}</span>` : ''}
        ${dateLabel ? `<span>${dateLabel}</span>` : ''}
        <span class="file-size">${sizeStr}</span>
      </div>
      <!-- 下载进度条 -->
      <div class="download-progress" data-progress="${index}" style="display:none;">
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
        <span class="progress-text">0%</span>
      </div>
    </div>
    <div class="actions">
      <button class="btn-dl${downloadedIds.has(video.id) ? ' btn-downloaded' : ''}" data-dl="${index}" title="${downloadedIds.has(video.id) ? '已下载，点击重新下载' : '下载'}">${downloadedIds.has(video.id) ? '✓' : '⬇'}</button>
    </div>
  `;

  card.querySelector('.btn-delete-corner')?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteVideo(Number(card.dataset.index));
  });
  card.querySelector('[data-dl]')?.addEventListener('click', () => handleDownload(Number(card.dataset.index)));
  card.querySelectorAll('[data-preview]').forEach(el => {
    el.addEventListener('click', () => openPreview(Number(card.dataset.index)));
  });

  videoList.appendChild(card);

  // 如果该视频正在下载，立即应用进度状态
  if (video.id && currentDownloads[video.id]) {
    applyDownloadProgressToCard(card, currentDownloads[video.id]);
  }
}

// ---------- 应用下载进度到卡片 ----------
function applyDownloadProgressToCard(card, progress) {
  const progressEl = card.querySelector('.download-progress');
  const fillEl = card.querySelector('.progress-fill');
  const textEl = card.querySelector('.progress-text');
  const btn = card.querySelector('.btn-dl');
  if (!progressEl || !btn) return;

  const { state, bytesReceived, totalBytes, speed } = progress;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesReceived / totalBytes) * 100)) : 0;

  if (state === 'queued') {
    progressEl.style.display = 'flex';
    fillEl.style.width = '0%';
    fillEl.style.background = '';
    textEl.style.color = '';
    textEl.textContent = '⏳ 排队中...';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'wait';
    btn.textContent = '⏳';
    btn.classList.remove('dl-success', 'dl-error');
  } else if (state === 'in_progress') {
    progressEl.style.display = 'flex';
    fillEl.style.width = percent + '%';
    fillEl.style.background = ''; // 清除完成/失败时的内联颜色，恢复 CSS 渐变
    textEl.style.color = '';
    const downloaded = formatFileSize(bytesReceived);
    const total = formatFileSize(totalBytes);
    const speedStr = formatSpeed(speed);
    let info = `${percent}%`;
    if (totalBytes > 0) info += ` · ${downloaded}/${total}`;
    if (speedStr) info += ` · ${speedStr}`;
    textEl.textContent = info;
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'wait';
    btn.textContent = percent > 0 ? percent + '%' : '⋯';
    btn.classList.remove('dl-success', 'dl-error');
  } else if (state === 'complete') {
    progressEl.style.display = 'flex';
    fillEl.style.width = '100%';
    fillEl.style.background = 'linear-gradient(90deg, #34c759, #30d158)';
    textEl.textContent = '✓ 已完成';
    textEl.style.color = '#34c759';
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = 'pointer';
    btn.textContent = '✓';
    btn.classList.add('dl-success');
    btn.classList.remove('dl-error');
  } else if (state === 'error') {
    progressEl.style.display = 'flex';
    fillEl.style.width = '100%';
    fillEl.style.background = 'linear-gradient(90deg, #ff3b30, #ff6b6b)';
    textEl.textContent = '❌ ' + (progress.error || '下载失败');
    textEl.style.color = '#ff3b30';
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = 'pointer';
    btn.textContent = '⟳';
    btn.classList.add('dl-error');
    btn.classList.remove('dl-success');
  }
}

// ---------- 更新所有卡片的下载进度（rAF 节流，避免高频 storage 事件反复写 DOM） ----------
let _progressRafPending = false;
function updateAllCardsProgress() {
  if (_progressRafPending) return;
  _progressRafPending = true;
  requestAnimationFrame(() => {
    _progressRafPending = false;
    const cards = videoList.querySelectorAll('.video-card');
    cards.forEach(card => {
      const videoId = card.dataset.videoId;
      if (videoId && currentDownloads[videoId]) {
        applyDownloadProgressToCard(card, currentDownloads[videoId]);
      }
    });
  });
}

// ---------- 刷新列表（增量渲染，避免整表重建导致抽搐/闪烁） ----------
// force=true 时强制全量重建（删除/排序变化等场景）
function sameIds(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// 列表结构变化后按 DOM 顺序重排卡片索引（data-index 是删除/预览/下载的事件来源）
function renumberCards() {
  const cards = videoList.querySelectorAll('.video-card');
  for (let i = 0; i < cards.length; i++) cards[i].dataset.index = String(i);
}

function refreshVideoList(force) {
  if (!force) {
    const existing = Array.from(videoList.querySelectorAll('.video-card'));
    const oldCount = existing.length;
    if (oldCount > 0) {
      const domIds = existing.map(c => c.dataset.videoId);
      const newIds = parsedVideos.map(v => v.id);
      // 完全一致：跳过（打开插件/状态刷新时避免重复全量重建导致闪烁）
      if (sameIds(newIds, domIds)) return;

      if (newIds.length > oldCount) {
        // 情况A：旧列表整体保留在尾部（后台把新结果 unshift 到最前）→ 只在前方插入新卡，
        // 旧卡片 DOM/封面不重建，从根源消除“新解析一个视频→整表重画→闪烁”问题
        if (sameIds(newIds.slice(newIds.length - oldCount), domIds)) {
          const firstOld = existing[0];
          const addCount = newIds.length - oldCount;
          for (let i = 0; i < addCount; i++) {
            renderCard(parsedVideos[i], i); // 先 append 到末尾
            videoList.insertBefore(videoList.lastElementChild, firstOld); // 再移到最前、保持顺序
          }
          renumberCards();
          updateToolbar();
          return;
        }
        // 情况B：旧列表整体保留在头部（尾部追加）→ 只追加新卡
        if (sameIds(newIds.slice(0, oldCount), domIds)) {
          for (let i = oldCount; i < newIds.length; i++) {
            renderCard(parsedVideos[i], i);
          }
          updateToolbar();
          return;
        }
      }
    }
  }
  // 其它情况（删除/排序变化/首尾都不匹配等）→ 整表重建
  videoList.innerHTML = '';
  parsedVideos.forEach((v, i) => renderCard(v, i));
  updateToolbar();
  if (parsedVideos.length === 0) {
    videoList.innerHTML = `<div class="empty-state"><div class="empty-glow"></div><div class="empty-icon">⬇️</div><p class="empty-title">粘贴链接，下载无水印视频</p><p class="empty-sub">支持 TikTok / 抖音 视频与图集</p><div class="empty-tips"><span class="tip-chip">🖱 搜索页 / 推荐页自动识别</span><span class="tip-chip">⚡ 免费 · 无限下载</span></div></div>`;
  }
}

// ---------- 只更新"已下载"徽标状态（下载完成时调用，不重建列表） ----------
function updateDownloadedBadges() {
  videoList.querySelectorAll('.video-card').forEach(card => {
    const vid = card.dataset.videoId;
    const btn = card.querySelector('.btn-dl');
    if (!vid || !btn) return;
    const done = downloadedIds.has(vid);
    const isMarked = btn.classList.contains('btn-downloaded');
    if (done && !isMarked) {
      btn.classList.add('btn-downloaded');
      btn.textContent = '✓';
      btn.title = '已下载，点击重新下载';
    } else if (!done && isMarked) {
      btn.classList.remove('btn-downloaded');
      btn.textContent = '⬇';
      btn.title = '下载';
    }
  });
}

// ---------- 删除 ----------
async function deleteVideo(index) {
  if (index < 0 || index >= parsedVideos.length) return;
  parsedVideos.splice(index, 1);
  refreshVideoList(true);
  await saveCache(parsedVideos);
}

function updateToolbar() {
  const successCount = parsedVideos.filter(v => v.success).length;
  if (successCount > 0) {
    resultToolbar.style.display = 'flex';
    videoCount.textContent = `已解析 ${successCount} 个视频`;
  } else {
    resultToolbar.style.display = 'none';
  }
}

// 更新下载历史工具栏
function updateHistoryToolbar() {
  const count = downloadedIds.size;
  if (count > 0) {
    historyToolbar.style.display = 'flex';
    downloadedCount.textContent = `已下载 ${count} 个视频`;
  } else {
    historyToolbar.style.display = 'none';
  }
}

// 导出下载历史为 JSON
function exportHistory() {
  const data = {
    exportedAt: new Date().toISOString(),
    total: downloadedIds.size,
    videoIds: Array.from(downloadedIds)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tiktok-download-history-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ 下载历史已导出');
}

// 清空下载历史
async function clearHistory() {
  if (!confirm(`确定要清空全部 ${downloadedIds.size} 条下载历史吗？（不会删除已下载的文件）`)) return;
  await chrome.storage.local.remove('downloadedIds');
  downloadedIds = new Set();
  updateHistoryToolbar();
  updateDownloadedBadges();
  showToast('✅ 下载历史已清空');
}

// 通过 videoId 查找卡片（比 index 更可靠，防止删除后错位）
function findCardByVideoId(videoId) {
  if (!videoId) return null;
  return videoList.querySelector(`.video-card[data-video-id="${videoId}"]`);
}

// ---------- 单个下载 ----------
function handleDownload(index) {
  const video = parsedVideos[index];
  if (!video || !video.success) {
    showToast('视频信息无效');
    return;
  }

  // 如果是错误状态的重试，先清除进度
  if (currentDownloads[video.id]?.state === 'error') {
    delete currentDownloads[video.id];
  }

  // 标记为下载中
  currentDownloads[video.id] = { state: 'in_progress', bytesReceived: 0, totalBytes: 0 };
  const card = findCardByVideoId(video.id);
  if (card) applyDownloadProgressToCard(card, currentDownloads[video.id]);

  chrome.runtime.sendMessage({
    type: 'download-single',
    video: video
  }, (response) => {
    updateStatus();
    if (response && response.success) {
      // 后台在下载全部结束后才回包（单视频等待完成；图集等待所有图片结束），
      // 所以这里可以放心把卡片标记为完成态，避免进度事件与回包之间的竞态显示
      if (response.error && /图集下载/.test(response.error)) {
        showToast('⚠️ ' + response.error);
      } else {
        showToast('✅ 下载完成');
      }
      currentDownloads[video.id] = { state: 'complete', bytesReceived: 0, totalBytes: 0 };
      const card = findCardByVideoId(video.id);
      if (card) applyDownloadProgressToCard(card, currentDownloads[video.id]);
    } else {
      const lastErr = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      const offline = !response && /Receiving end|message port|Could not establish|Extension context invalidated/i.test(lastErr || '');
      const errMsg = response?.reason || response?.error || lastErr || '未知错误';
      showToast(offline ? '❌ 后台未响应：请在扩展管理页重新加载本扩展' : ('❌ 下载失败：' + errMsg));
      // 更新为错误状态
      currentDownloads[video.id] = { state: 'error', error: errMsg, bytesReceived: 0, totalBytes: 0 };
      const card = findCardByVideoId(video.id);
      if (card) applyDownloadProgressToCard(card, currentDownloads[video.id]);
      if (offline) showBgOffline();
      console.error('[下载失败]', errMsg, '链接:', video.videoUrl || video.hdVideoUrl);
    }
  });
}

// ---------- 下载全部 ----------
function downloadAllVideos() {
  let successVideos = parsedVideos.filter(v => v.success);
  if (successVideos.length === 0) {
    showToast('没有可下载的视频');
    return;
  }

  // 跳过已下载
  const skipDownloaded = skipDownloadedCheckbox?.checked;
  let skippedCount = 0;
  if (skipDownloaded) {
    const before = successVideos.length;
    successVideos = successVideos.filter(v => !downloadedIds.has(v.id));
    skippedCount = before - successVideos.length;
  }
  if (successVideos.length === 0) {
    showToast(skippedCount > 0 ? `已跳过 ${skippedCount} 个已下载视频，没有新视频可下载` : '没有可下载的视频');
    return;
  }

  // 标记所有为排队中
  successVideos.forEach(v => {
    currentDownloads[v.id] = { state: 'queued', bytesReceived: 0, totalBytes: 0 };
  });
  updateAllCardsProgress();

  const msg = skippedCount > 0 ? `⏳ 已跳过 ${skippedCount} 个已下载，开始下载 ${successVideos.length} 个...` : '⏳ 正在启动后台下载...';
  showToast(msg);
  chrome.runtime.sendMessage({
    type: 'download-all-background',
    videos: successVideos
  }, (response) => {
    if (response && response.success) {
      if (response.started) {
        showToast(`🚀 已启动下载 ${response.total} 个视频（3并发）`);
      } else {
        showToast(`✅ 后台已开始下载 ${response.successCount || 0} 个视频`);
      }
    } else {
      showToast('❌ ' + (response?.reason || '启动后台下载失败'));
      // 清除所有排队/下载中状态
      successVideos.forEach(v => delete currentDownloads[v.id]);
      updateAllCardsProgress();
    }
  });
}

// ---------- 缓存恢复 ----------
async function restoreCache() {
  const cached = await loadCache();
  if (cached && cached.length > 0) {
    parsedVideos = normalizeVideos(cached);
    refreshVideoList();
  }
}

// ---------- 预览 ----------
function openPreview(index) {
  const v = parsedVideos[index];
  if (!v || !v.success) return;
  const url = v.hdVideoUrl || v.videoUrl;
  if (!url) return;
  previewVideo.src = url;
  previewTitle.textContent = v.title;
  previewAuthor.textContent = v.author;
  previewModal.style.display = 'flex';
  previewVideo.play().catch(() => {});
}

function closePreview() {
  previewModal.style.display = 'none';
  previewVideo.pause();
  previewVideo.src = '';
}

// ---------- Toast ----------
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ---------- 状态指示器 ----------
function showStatus(message, isError = false) {
  statusIndicator.style.display = 'inline-flex';
  statusMessage.textContent = message;
  if (isError) statusIndicator.classList.add('error');
  else statusIndicator.classList.remove('error');
}

function hideStatus() {
  statusIndicator.style.display = 'none';
  statusIndicator.classList.remove('error');
}

// ---------- 主题 ----------
function applyTheme(theme) {
  currentTheme = theme;
  // 镜像到 localStorage，供 popup.html 首屏内联脚本在渲染前锁定配色（防打开闪烁）
  try { localStorage.setItem('td_theme', theme); } catch (e) {}
  const root = document.documentElement;
  if (theme === 'dark') {
    root.style.setProperty('--bg', '#0a0a14');
    root.style.setProperty('--bg-gradient', 'linear-gradient(160deg, #0d0d1a 0%, #0a0a14 50%, #111125 100%)');
    root.style.setProperty('--bg-card', 'rgba(255,255,255,0.05)');
    root.style.setProperty('--bg-card-hover', 'rgba(255,255,255,0.09)');
    root.style.setProperty('--bg-input', 'rgba(255,255,255,0.04)');
    root.style.setProperty('--border', 'rgba(255,255,255,0.07)');
    root.style.setProperty('--border-hover', 'rgba(255,255,255,0.14)');
    root.style.setProperty('--text', '#f0f0f5');
    root.style.setProperty('--text-secondary', '#9898b8');
    root.style.setProperty('--text-muted', '#5a5a7a');
  } else {
    root.style.setProperty('--bg', '#f0f0f5');
    root.style.setProperty('--bg-gradient', 'linear-gradient(160deg, #f5f5fa 0%, #f0f0f5 50%, #e8e8f0 100%)');
    root.style.setProperty('--bg-card', 'rgba(255,255,255,0.75)');
    root.style.setProperty('--bg-card-hover', 'rgba(255,255,255,0.95)');
    root.style.setProperty('--bg-input', 'rgba(0,0,0,0.03)');
    root.style.setProperty('--border', 'rgba(0,0,0,0.07)');
    root.style.setProperty('--border-hover', 'rgba(0,0,0,0.13)');
    root.style.setProperty('--text', '#1a1a2e');
    root.style.setProperty('--text-secondary', '#666688');
    root.style.setProperty('--text-muted', '#9999bb');
  }
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// 后台是否存活：个别浏览器（如豆包）后台 Service Worker 可能启动失败，
// 先检测再提示，避免“点了解析/下载没反应”。
function checkBackgroundReady() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      chrome.runtime.sendMessage({ type: 'ping' }, (resp) => {
        if (chrome.runtime.lastError) finish(false);
        else finish(!!(resp && resp.ok));
      });
    } catch (e) { finish(false); }
    setTimeout(() => finish(false), 2000);
  });
}

// 后台不可用提示（解析/下载都会无响应时的明确反馈）
function showBgOffline() {
  statusText.innerHTML = '⚠️ 后台未响应：请在扩展管理页重新加载本扩展；若仍无效，请查看后台 Service Worker 控制台错误';
  statusText.style.color = '#ff6b6b';
  try {
    console.error('[bg-offline] 后台 ping 多次无响应（常见于豆包等浏览器对扩展限制，或 SW 启动报错）');
  } catch (e) {}
}

// 检查扩展后台服务是否可用，重试 3 次避免误报（SW 冷启动需要时间）
function detectBackground() {
  let attempts = 0;
  const tryPing = () => checkBackgroundReady().then((ready) => {
    if (ready) { updateStatus(); return; }
    attempts++;
    if (attempts < 3) setTimeout(tryPing, 800);
    else showBgOffline();
  });
  tryPing();
}

// ============================================================
//  后台解析相关
// ============================================================
async function checkParseProgress() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-parse-progress' }, (progress) => {
      if (progress && progress.status === 'running') {
        const queueInfo = progress.queueLength > 0 ? `，队列等待 ${progress.queueLength} 个` : '';
        showStatus(`后台解析中 ${progress.completed}/${progress.total}${queueInfo}`);
        parseBtn.disabled = true;
        parseBtn.style.opacity = '0.5';
        parseBtn.style.cursor = 'wait';
        parseBtn.textContent = '解析中';
      } else {
        hideStatus();
        parseBtn.disabled = false;
        parseBtn.style.opacity = '';
        parseBtn.style.cursor = '';
        parseBtn.textContent = '解析';
      }
      resolve(progress);
    });
  });
}

async function handleParse(allowDuplicate = false, silent = false) {
  const text = urlInput.value.trim();
  if (!text) { if (!silent) showToast('请粘贴链接'); return; }
  const urls = text.match(/https?:\/\/[^\s]+/g) || [];
  const tiktokUrls = urls.filter(u => u.includes('tiktok.com') || u.includes('douyin.com'));
  if (tiktokUrls.length === 0) { if (!silent) showToast('未找到有效链接'); return; }

  // 过滤掉已经成功解析过的链接：输入框里通常保留着之前解析过的历史链接，
  // 如果不过滤，每次“解析一条新视频”都会把前面所有链接重新提交给后台再解析一遍。
  const known = new Set(
    parsedVideos
      .filter(v => v.success && v.originalUrl)
      .map(v => v.originalUrl.replace(/\/+$/, ''))
  );
  const seen = new Set();
  const freshUrls = [];
  for (const u of tiktokUrls) {
    const key = u.replace(/\/+$/, '');
    if (seen.has(key) || known.has(key)) continue;
    seen.add(key);
    freshUrls.push(u);
  }
  const dupCount = tiktokUrls.length - freshUrls.length;
  if (freshUrls.length === 0) {
    if (!silent) showToast(dupCount > 0 ? '这些链接之前都已解析过' : '未找到新的链接');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'start-parse',
    urls: freshUrls,
    allowDuplicate: allowDuplicate
  }, (response) => {
    if (response && response.success) {
      const skipMsg = dupCount > 0 ? `（已跳过 ${dupCount} 个之前解析过的链接）` : '';
      if (response.queued) {
        showToast(`📋 已加入队列，前面还有 ${response.queueLength - 1} 个任务，共 ${response.total} 个视频${skipMsg}`);
      } else {
        showToast(`🚀 已开始解析 ${response.total} 个视频${skipMsg}`);
      }
      parseBtn.disabled = true;
      parseBtn.style.opacity = '0.5';
      parseBtn.style.cursor = 'wait';
      parseBtn.textContent = '解析中';
      stopParseBtn.style.display = '';
    } else {
      const lastErr = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      const offline = !response && /Receiving end|message port|Could not establish|Extension context invalidated/i.test(lastErr || '');
      if (offline) {
        showToast('❌ 后台未响应：请在扩展管理页重新加载本扩展');
        showBgOffline();
      } else {
        showToast('❌ ' + (response?.reason || lastErr || '提交解析失败'));
      }
    }
  });
}

function grabCurrentPageUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].url) {
      const url = tabs[0].url;
      if (url.includes('tiktok.com') || url.includes('douyin.com')) {
        const existing = urlInput.value.trim();
        urlInput.value = existing ? existing + '\n' + url : url;
        showToast('✅ 已追加当前页链接');
      } else {
        showToast('当前页不是TikTok/抖音');
      }
    }
  });
}

async function clearAll() {
  urlInput.value = '';
  parsedVideos = [];
  currentDownloads = {};
  await chrome.storage.local.remove('cachedVideos');
  hideStatus();
  // 统一走 refreshVideoList 渲染标准空态，避免手工 innerHTML 与空态模板不一致
  refreshVideoList(true);
}

// ============================================================
//  事件绑定
// ============================================================
function setupEvents() {
  // 手动解析按钮：与自动解析一致不允许重复添加，避免缓存里反复堆积重复项
  parseBtn.addEventListener('click', () => handleParse(false));
  clearBtn.addEventListener('click', clearAll);
  grabBtn.addEventListener('click', grabCurrentPageUrl);
  stopParseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop-parse' }, () => {
      showToast('已停止解析');
    });
  });
  downloadAllBtn.addEventListener('click', downloadAllVideos);
  exportHistoryBtn.addEventListener('click', exportHistory);
  clearHistoryBtn.addEventListener('click', clearHistory);
  // 推荐页自动解析开关
  recommendAutoParseToggle.addEventListener('change', () => {
    const enabled = recommendAutoParseToggle.checked;
    chrome.storage.local.set({ recommendAutoParse: enabled }, () => {
      showToast(enabled ? '✅ 推荐页自动解析已开启' : '🔕 推荐页自动解析已关闭');
    });
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') handleParse(false);
  });

  previewClose.addEventListener('click', closePreview);
  previewOverlay.addEventListener('click', closePreview);

  themeToggle.addEventListener('click', () => {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.local.set({ themePreference: next });
  });

  // 独立窗口按钮：打开一个不会自动关闭的独立窗口（限制只能开一个）
  openWindowBtn.addEventListener('click', () => {
    // 先查找是否已有独立窗口在运行
    chrome.tabs.query({ url: chrome.runtime.getURL('popup.html') + '*' }, (tabs) => {
      const existingWindowTab = tabs.find(t => t.url && t.url.includes('window=1'));
      if (existingWindowTab?.windowId) {
        // 已有独立窗口，聚焦到它
        chrome.windows.update(existingWindowTab.windowId, { focused: true });
        chrome.tabs.update(existingWindowTab.id, { active: true });
        window.close();
      } else {
        // 没有，新开一个
        chrome.windows.create({
          url: chrome.runtime.getURL('popup.html') + '?window=1',
          type: 'popup',
          width: 480,
          height: 720,
          focused: true
        }, () => {
          window.close();
        });
      }
    });
  });

  // 侧边栏按钮：在浏览器右侧打开侧边栏（始终可见，不被标签页覆盖）
  sidePanelBtn.addEventListener('click', () => {
    chrome.windows.getCurrent((win) => {
      if (win?.id && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ windowId: win.id }, () => {
          window.close();
        });
      } else {
        showToast('⚠️ 当前浏览器不支持侧边栏（需 Chrome 114+）');
      }
    });
  });

  // 监听 storage 变化
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // 解析进度
    if (changes.parseProgress) {
      const progress = changes.parseProgress.newValue;
      if (progress?.status === 'running') {
        const queueInfo = progress.queueLength > 0 ? `，队列等待 ${progress.queueLength} 个` : '';
        showStatus(`后台解析中 ${progress.completed}/${progress.total}${queueInfo}`);
        parseBtn.disabled = true;
        parseBtn.style.opacity = '0.5';
        parseBtn.style.cursor = 'wait';
        parseBtn.textContent = '解析中';
        stopParseBtn.style.display = '';
      } else if (progress?.status === 'done') {
        hideStatus();
        parseBtn.disabled = false;
        parseBtn.style.opacity = '';
        parseBtn.style.cursor = '';
        parseBtn.textContent = '解析';
        stopParseBtn.style.display = 'none';
        loadCache().then(videos => {
          parsedVideos = videos || [];
          refreshVideoList();
          updateStatus();
        });
      } else {
        hideStatus();
        parseBtn.disabled = false;
        parseBtn.style.opacity = '';
        parseBtn.style.cursor = '';
        parseBtn.textContent = '解析';
        stopParseBtn.style.display = 'none';
      }
    }

    // 下载进度（核心新增）
    if (changes.downloadProgress) {
      const progressMap = changes.downloadProgress.newValue || {};
      // 转换为 videoId -> progress 的映射
      const newDownloads = {};
      for (const downloadId in progressMap) {
        const p = progressMap[downloadId];
        if (p?.videoId) {
          newDownloads[String(p.videoId)] = {
            state: p.state,
            bytesReceived: p.bytesReceived || 0,
            totalBytes: p.totalBytes || 0,
            speed: p.speed || 0,
            error: p.error || ''
          };
        }
      }
      currentDownloads = newDownloads;
      updateAllCardsProgress();
    }

    // 缓存视频变化
    if (changes.cachedVideos && !changes.parseProgress) {
      const newVideos = normalizeVideos(changes.cachedVideos.newValue || []);
      parsedVideos = newVideos;
      refreshVideoList();
    }

    // 下载历史变化：只更新徽标和计数，不重建列表（避免整表闪烁）
    if (changes.downloadedIds) {
      downloadedIds = new Set((changes.downloadedIds.newValue || []).map(String));
      updateHistoryToolbar();
      updateDownloadedBadges();
    }
  });
}

// ============================================================
//  初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // 显示当前版本号（确认扩展已更新到最新）
  try { document.getElementById('versionTag').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  const pref = (await chrome.storage.local.get('themePreference')).themePreference || 'dark';
  applyTheme(pref);
  await updateStatus();
  await restoreCache();
  setupEvents();
  updateToolbar();

  // 恢复推荐页自动解析开关状态
  try {
    const recPref = await chrome.storage.local.get('recommendAutoParse');
    recommendAutoParseToggle.checked = recPref.recommendAutoParse !== false;
  } catch (e) {
    recommendAutoParseToggle.checked = true;
  }

  // 检查是否有正在进行的后台解析
  await checkParseProgress();

  // 后台存活检测（个别浏览器后台启动失败时给出明确提示）
  detectBackground();

  // 恢复当前下载进度
  try {
    const stored = await chrome.storage.local.get('downloadProgress');
    if (stored.downloadProgress) {
      const newDownloads = {};
      for (const downloadId in stored.downloadProgress) {
        const p = stored.downloadProgress[downloadId];
        if (p?.videoId) {
          newDownloads[String(p.videoId)] = {
            state: p.state,
            bytesReceived: p.bytesReceived || 0,
            totalBytes: p.totalBytes || 0,
            speed: p.speed || 0,
            error: p.error || ''
          };
        }
      }
      currentDownloads = newDownloads;
      updateAllCardsProgress();
    }
  } catch (e) {}

  // 恢复下载历史
  try {
    const stored = await chrome.storage.local.get('downloadedIds');
    downloadedIds = new Set((stored.downloadedIds || []).map(String));
    updateHistoryToolbar();
  } catch (e) {}

  // 注：自动抓取/自动解析当前视频页由下方 setupAutoParse 统一处理（覆盖视频页/首页/推荐页/搜索页/
  // 标签页/用户主页，且在弹窗/侧边栏/独立窗口三种模式共用）。这里不再单独开一个 400ms 定时器，
  // 否则会与 setupAutoParse 的首次触发重复提交解析。

  // ===== 共享：自动解析目标判定（视频页/推荐页/搜索页/标签页/用户主页） =====
  async function getAutoParseTarget(tab) {
    const url = (tab && tab.url) || '';
    if (!url) return '';
    if (!/tiktok\.com|douyin\.com|iesdouyin\.com|tiktokv\.com/.test(url)) return '';
    // 视频详情页 / 短链：直接用页面 URL
    if (/\/video\/\d+|\/v\/\d+|v\.douyin\.com|vm\.tiktok\.com/.test(url)) return url;
    // 搜索页 / 标签页 / 用户主页 / 推荐页 / 首页：提取视口内第一个视频链接
    if (/\/search|\/tag\/|\/@|foryou|^https?:\/\/(www\.)?tiktok\.com\/?(\?|$)|^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/?(\?|$)|^https?:\/\/(www\.)?douyin\.com\/?(\?|$)/.test(url)) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
            for (const a of links) {
              const r = a.getBoundingClientRect();
              if (r.width > 0 && r.bottom > 0 && r.top < window.innerHeight) {
                const m1 = a.href.match(/\/@([^\/?]+)\/video\/(\d+)/);
                if (m1) return 'https://www.tiktok.com/@' + m1[1] + '/video/' + m1[2];
                const m2 = a.href.match(/\/video\/(\d+)/);
                if (m2) return 'https://www.tiktok.com/video/' + m2[1];
              }
            }
            return '';
          }
        });
        return (res && res[0] && res[0].result) || '';
      } catch (e) {
        // chrome.scripting 不可用（Firefox/老内核浏览器）时退化为直接解析页面 URL：
        // 后台/自建后端会从页面数据里深度解析出视频，精度略低但保证“自动解析”可用
        return url;
      }
    }
    return '';
  }

  // ===== 通用：注册自动解析（弹窗 / 侧边栏 / 独立窗口共用） =====
  function setupAutoParse(tabQueryOpts) {
    let autoParseTimer = null;
    let lastAutoParsedUrl = '';

    async function tryAutoParse() {
      try {
        const tabs = await chrome.tabs.query(tabQueryOpts);
        const list = Array.isArray(tabs) ? tabs : (tabs ? [tabs] : []);
        for (const t of list) {
          if (!t || !t.url) continue;
          const target = await getAutoParseTarget(t);
          if (target && target !== lastAutoParsedUrl) {
            lastAutoParsedUrl = target;
            // 追加而不是覆盖输入框：不弄丢用户已经粘贴/输入的其它链接
            const lines = (urlInput.value || '').split('\n').map(s => s.trim()).filter(Boolean);
            if (!lines.includes(target)) {
              lines.push(target);
              urlInput.value = lines.join('\n');
            }
            handleParse(false, true); // 解析中也提交，后台会排队（silent：重复目标时不打扰）
            break;
          }
        }
        // 诊断：一次都没命中时，在空态区显示检测到的标签页（截图即可定位问题）
        if (!lastAutoParsedUrl) {
          const urls = list.map(t=>t&&t.url).filter(Boolean);
          console.log('[autoparse] no target. tabs=', urls);
          try {
            const sub = videoList.querySelector('.empty-sub');
            if (sub && urls.length) {
              sub.textContent = '检测到: ' + urls[0].slice(0, 70);
              sub.style.color = '#ff6b6b';
            } else if (sub) {
              sub.textContent = '未检测到标签页（tabs 查询为空）';
              sub.style.color = '#ff6b6b';
            }
          } catch (e) {}
        }
      } catch (e) { console.log('[autoparse] error:', e && e.message); }
    }

    // 切换标签页时触发（无延迟）
    chrome.tabs.onActivated.addListener(() => {
      clearTimeout(autoParseTimer);
      autoParseTimer = setTimeout(tryAutoParse, 100);
    });

    // 标签页 URL 变化时触发（无延迟）
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url && tab.active) {
        clearTimeout(autoParseTimer);
        autoParseTimer = setTimeout(tryAutoParse, 100);
      }
    });

    // 打开时立即尝试一次，页面未就绪时 1.5s 后再补一次（提取视口视频依赖页面渲染）
    setTimeout(tryAutoParse, 300);
    setTimeout(() => {
      if (!lastAutoParsedUrl) tryAutoParse();
    }, 1500);
  }

  // ===== 独立窗口模式：自动解析切换后的视频 =====
  const isWindowMode = new URLSearchParams(window.location.search).get('window') === '1';
  if (isWindowMode) {
    document.body.classList.add('window-mode');
    bringToFrontBtn.style.display = 'flex';
    openWindowBtn.style.display = 'none'; // 独立窗口里不需要再打开独立窗口

    // 拉到最前面按钮（先最小化再恢复，确保弹到最上层）
    bringToFrontBtn.addEventListener('click', () => {
      chrome.windows.getCurrent((win) => {
        if (win?.id) {
          chrome.windows.update(win.id, { state: 'minimized' }, () => {
            setTimeout(() => {
              chrome.windows.update(win.id, { state: 'normal', focused: true });
            }, 120);
          });
        }
      });
    });

    // 独立窗口：查询所有窗口的活动标签页（currentWindow 是 popup 自己）
    setupAutoParse({ active: true });
  }

  // ===== 侧边栏模式：自动解析切换后的视频 =====
  const isSidePanel = window.location.hash === '#sidepanel';
  if (isSidePanel) {
    document.body.classList.add('sidepanel-mode');
    bringToFrontBtn.style.display = 'none';
    openWindowBtn.style.display = 'none';
    sidePanelBtn.style.display = 'none'; // 已经在侧边栏里了

    // 侧边栏：当前窗口的活动标签页
    setupAutoParse({ active: true });
  }

  // ===== 弹窗（默认）模式：同样支持自动解析 =====
  if (!isWindowMode && !isSidePanel) {
    setupAutoParse({ active: true });
  }
});
