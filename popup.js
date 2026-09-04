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

// ---------- 缓存 ----------
async function saveCache(videos) {
  await chrome.storage.local.set({ cachedVideos: videos });
}

async function loadCache() {
  const result = await chrome.storage.local.get('cachedVideos');
  return result.cachedVideos || [];
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
      deleteVideo(index);
    });
    videoList.appendChild(card);
    return;
  }

  const dur = formatDuration(video.duration);
  const sizeStr = video.fileSize ? formatFileSize(video.fileSize) : '';
  const safeTitle = escapeHtml(video.title);
  const safeAuthor = escapeHtml(video.author);
  const safeCover = (video.cover && /^https?:\/\//i.test(video.cover)) ? video.cover : '';
  const langLabel = video.language ? `🌐 ${escapeHtml(video.language)}` : '';
  const likesLabel = video.likes ? `❤️ ${escapeHtml(video.likes)}` : '';
  const dateLabel = video.createTime ? `📅 ${escapeHtml(video.createTime)}` : '';
  const sourceLabel = getSourceLabel(video._parseSource);

  card.innerHTML = `
    <div class="cover" data-preview="${index}" style="cursor:pointer;">
      <img src="${safeCover}" onerror="this.style.display='none'">
      ${dur ? `<div class="dur">${dur}</div>` : ''}
      ${sourceLabel ? `<div class="source-badge">${sourceLabel}</div>` : ''}
    </div>
    <div class="info">
      <button class="btn-delete-corner" data-del="${index}">✕</button>
      <div class="title" data-preview="${index}" title="${safeTitle}">${safeTitle}</div>
      <div class="meta">
        <span class="author">👤 ${safeAuthor}</span>
        <span class="quality">${escapeHtml(video.quality || '高清')}</span>
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
    deleteVideo(index);
  });
  card.querySelector('[data-dl]')?.addEventListener('click', () => handleDownload(index));
  card.querySelectorAll('[data-preview]').forEach(el => {
    el.addEventListener('click', () => openPreview(parseInt(el.dataset.preview)));
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

// ---------- 更新所有卡片的下载进度 ----------
function updateAllCardsProgress() {
  const cards = videoList.querySelectorAll('.video-card');
  cards.forEach(card => {
    const videoId = card.dataset.videoId;
    if (videoId && currentDownloads[videoId]) {
      applyDownloadProgressToCard(card, currentDownloads[videoId]);
    }
  });
}

// ---------- 刷新列表 ----------
function refreshVideoList() {
  videoList.innerHTML = '';
  parsedVideos.forEach((v, i) => renderCard(v, i));
  updateToolbar();
  if (parsedVideos.length === 0) {
    videoList.innerHTML = `<div class="empty-state"><div class="empty-icon">🎬</div><p>粘贴链接开始解析</p></div>`;
  }
}

// ---------- 删除 ----------
async function deleteVideo(index) {
  if (index < 0 || index >= parsedVideos.length) return;
  parsedVideos.splice(index, 1);
  refreshVideoList();
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
  refreshVideoList();
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
      showToast('✅ 下载已开始');
    } else {
      const errMsg = response?.reason || response?.error || '未知错误';
      showToast('❌ 下载失败：' + errMsg);
      // 更新为错误状态
      currentDownloads[video.id] = { state: 'error', error: errMsg, bytesReceived: 0, totalBytes: 0 };
      const card = findCardByVideoId(video.id);
      if (card) applyDownloadProgressToCard(card, currentDownloads[video.id]);
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
    parsedVideos = cached;
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

async function handleParse(allowDuplicate = false) {
  const text = urlInput.value.trim();
  if (!text) { showToast('请粘贴链接'); return; }
  const urls = text.match(/https?:\/\/[^\s]+/g) || [];
  const tiktokUrls = urls.filter(u => u.includes('tiktok.com') || u.includes('douyin.com'));
  if (tiktokUrls.length === 0) { showToast('未找到有效链接'); return; }

  chrome.runtime.sendMessage({
    type: 'start-parse',
    urls: tiktokUrls,
    allowDuplicate: allowDuplicate
  }, (response) => {
    if (response && response.success) {
      if (response.queued) {
        showToast(`📋 已加入队列，前面还有 ${response.queueLength - 1} 个任务，共 ${response.total} 个视频`);
      } else {
        showToast(`🚀 已开始解析 ${response.total} 个视频，完成后会通知你`);
      }
      urlInput.value = '';
      parseBtn.disabled = true;
      parseBtn.style.opacity = '0.5';
      parseBtn.style.cursor = 'wait';
      parseBtn.textContent = '解析中';
      stopParseBtn.style.display = '';
    } else {
      showToast('❌ ' + (response?.reason || '提交解析失败'));
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
  updateToolbar();
  videoList.innerHTML = `<div class="empty-state"><div class="empty-icon">🎬</div><p>粘贴链接开始解析</p></div>`;
}

// ============================================================
//  事件绑定
// ============================================================
function setupEvents() {
  parseBtn.addEventListener('click', () => handleParse(true));
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
    if (e.ctrlKey && e.key === 'Enter') handleParse(true);
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
          newDownloads[p.videoId] = {
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
      const newVideos = changes.cachedVideos.newValue || [];
      parsedVideos = newVideos;
      refreshVideoList();
    }

    // 下载历史变化
    if (changes.downloadedIds) {
      downloadedIds = new Set(changes.downloadedIds.newValue || []);
      updateHistoryToolbar();
      refreshVideoList();
    }
  });
}

// ============================================================
//  初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
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

  // 恢复当前下载进度
  try {
    const stored = await chrome.storage.local.get('downloadProgress');
    if (stored.downloadProgress) {
      const newDownloads = {};
      for (const downloadId in stored.downloadProgress) {
        const p = stored.downloadProgress[downloadId];
        if (p?.videoId) {
          newDownloads[p.videoId] = {
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
    downloadedIds = new Set(stored.downloadedIds || []);
    updateHistoryToolbar();
  } catch (e) {}

  // 自动抓取当前页
  setTimeout(async () => {
    try {
      const progress = await checkParseProgress();
      if (progress?.status === 'running') return;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs?.[0]?.url) {
        const url = tabs[0].url;
        // 只在视频详情页和首页/推荐页自动解析，搜索页/用户主页不自动解析
        const isVideoPage = url.includes('/video/') || url.includes('/v/') || url.includes('v.douyin.com')
                        || /^https?:\/\/(www\.)?tiktok\.com\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/foryou\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/foryou\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?douyin\.com\/?(\?|$)/.test(url);
        if (isVideoPage) {
          urlInput.value = url;
          handleParse(false);
        }
      }
    } catch (e) {}
  }, 400);

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

    let autoParseTimer = null;
    let lastAutoParsedUrl = '';

    async function tryAutoParse() {
      try {
        // 独立窗口模式下 currentWindow 是 popup 自己，所以查询所有窗口的活动标签页
        const tabs = await chrome.tabs.query({ active: true });
        // 只匹配视频详情页和首页/推荐页，排除搜索页/用户主页
        const videoTab = tabs.find(t => {
          const u = t.url || '';
          return u.includes('/video/') || u.includes('/v/') || u.includes('v.douyin.com')
              || /^https?:\/\/(www\.)?tiktok\.com\/?(\?|$)/.test(u)
              || /^https?:\/\/(www\.)?tiktok\.com\/foryou\/?(\?|$)/.test(u)
              || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/?(\?|$)/.test(u)
              || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/foryou\/?(\?|$)/.test(u)
              || /^https?:\/\/(www\.)?douyin\.com\/?(\?|$)/.test(u);
        });
        const url = videoTab?.url || '';
        if (!url) return;
        if (url !== lastAutoParsedUrl) {
          lastAutoParsedUrl = url;
          urlInput.value = url;
          handleParse(false); // 解析中也提交，后台会排队
        }
      } catch (e) {}
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

    // 独立窗口打开时立即尝试一次
    setTimeout(tryAutoParse, 300);
  }

  // ===== 侧边栏模式：自动解析切换后的视频 =====
  const isSidePanel = window.location.hash === '#sidepanel';
  if (isSidePanel) {
    document.body.classList.add('sidepanel-mode');
    bringToFrontBtn.style.display = 'none';
    openWindowBtn.style.display = 'none';
    sidePanelBtn.style.display = 'none'; // 已经在侧边栏里了

    let autoParseTimer = null;
    let lastAutoParsedUrl = '';

    async function tryAutoParse() {
      try {
        // 侧边栏在浏览器窗口内，currentWindow 是正确的
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tabs?.[0]?.url || '';
        if (!url) return;
        // 只匹配视频详情页和首页/推荐页，排除搜索页/用户主页
        const isVideoPage = url.includes('/video/') || url.includes('/v/') || url.includes('v.douyin.com')
                        || /^https?:\/\/(www\.)?tiktok\.com\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/foryou\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?tiktok\.com\/[a-z]{2}\/foryou\/?(\?|$)/.test(url)
                        || /^https?:\/\/(www\.)?douyin\.com\/?(\?|$)/.test(url);
        if (isVideoPage && url !== lastAutoParsedUrl) {
          lastAutoParsedUrl = url;
          urlInput.value = url;
          handleParse(false);
        }
      } catch (e) {}
    }

    chrome.tabs.onActivated.addListener(() => {
      clearTimeout(autoParseTimer);
      autoParseTimer = setTimeout(tryAutoParse, 100);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url && tab.active) {
        clearTimeout(autoParseTimer);
        autoParseTimer = setTimeout(tryAutoParse, 100);
      }
    });

    setTimeout(tryAutoParse, 300);
  }
});
