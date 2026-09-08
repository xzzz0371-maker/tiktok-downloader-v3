// ============================================================
// autoparse_test.js — 自动解析全链路模拟测试
// 用 mock 浏览器环境真实执行 popup.js（等价于模拟打开弹窗），验证：
//   场景A 视频页：直接匹配 URL → 自动填入 + 提交解析 + 链接保留
//   场景B 搜索页：executeScript 提取视口视频 → 自动填入 + 提交
//   场景C 非TikTok页：不解析、不报错，显示诊断
// 运行：node autoparse_test.js
// ============================================================
const fs = require('fs');
const vm = require('vm');

const TEST_URL = 'https://www.tiktok.com/@qaom9twgj8/video/7657172908623645969';
const SEARCH_URL = 'https://www.tiktok.com/search?q=nose';
const OTHER_URL = 'https://github.com/xzzz0371-maker/tiktok-downloader-v3';
const VERSION = '4.3.1';

// ---------- mock 元素 ----------
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    checked: true,
    style: {},
    dataset: {},
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, cb) { (this._listeners = this._listeners || {})[type] = cb; },
    appendChild() {}, removeChild() {}, insertBefore() {}, setAttribute() {},
    remove() {}, focus() {}, click() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    requestFullscreen() { return Promise.resolve(); },
    play() { return Promise.resolve(); }, pause() {},
    load() {},
  };
}

const ids = ['urlInput','parseBtn','clearBtn','grabBtn','stopParseBtn','recommendAutoParse','videoList','toast','statusBadge','statusText','themeToggle','openWindowBtn','bringToFrontBtn','sidePanelBtn','statusIndicator','statusMessage','resultToolbar','videoCount','downloadAllBtn','skipDownloaded','historyToolbar','downloadedCount','exportHistoryBtn','clearHistoryBtn','previewModal','previewVideo','previewClose','previewOverlay','previewTitle','previewAuthor','versionTag'];

// ---------- chrome mock ----------
const sentMessages = [];
let CURRENT_TAB_URL = TEST_URL;
let EXEC_RESULT = TEST_URL;

function proxify(obj, path) {
  return new Proxy(obj, {
    get(t, p) {
      if (!(p in t)) {
        console.log('[mock-miss] ' + path + '.' + String(p));
        return undefined;
      }
      const v = t[p];
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return proxify(v, path + '.' + String(p));
      return v;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function buildSandbox(els) {
  const listeners = { activated: [], updated: [] };
  const chromeMock = proxify({
    storage: {
      local: {
        async get(key) {
          const all = { themePreference: 'dark', recommendAutoParse: true, downloadProgress: null };
          if (key == null) return all;
          if (typeof key === 'string') return { [key]: all[key] };
          if (Array.isArray(key)) { const o = {}; key.forEach(k => o[k] = all[k]); return o; }
          if (typeof key === 'object') { const o = {}; for (const k in key) o[k] = all[k] !== undefined ? all[k] : key[k]; return o; }
          return {};
        },
        async set(obj) { return obj; },
        async remove() { return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    sidePanel: { open() { return Promise.resolve(); } },
    runtime: {
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        if (typeof cb === 'function') setTimeout(() => cb({ success: true, queued: false, total: 1 }), 0);
        return Promise.resolve({ success: true });
      },
      getURL(p) { return 'chrome-extension://test/' + p; },
      getManifest() { return { version: VERSION }; },
      lastError: null,
      onMessage: { addListener() {} },
    },
    tabs: {
      query(opts, cb) {
        const tabs = [{ id: 1, url: CURRENT_TAB_URL, active: true, windowId: 1 }];
        if (typeof cb === 'function') setTimeout(() => cb(tabs), 0);
        return Promise.resolve(tabs);
      },
      update() { return Promise.resolve(); },
      onActivated: { addListener(cb) { listeners.activated.push(cb); } },
      onUpdated: { addListener(cb) { listeners.updated.push(cb); } },
      onRemoved: { addListener() {} },
    },
    windows: {
      getCurrent(cb) { const w = { id: 1, type: 'normal' }; if (cb) setTimeout(() => cb(w), 0); return Promise.resolve(w); },
      update() { return Promise.resolve(); },
      create(opts, cb) { const w = { id: 99, ...opts }; if (cb) setTimeout(() => cb(w), 0); return Promise.resolve(w); },
    },
    scripting: {
      executeScript() { return Promise.resolve([{ result: EXEC_RESULT }]); },
    },
  }, 'chrome');

  let domContentLoadedCb = null;
  // videoList 的空态子元素：querySelector 需返回同一实例（诊断写入后可读）
  els.videoList._emptySub = makeEl('div');
  els.videoList._emptySub.style = {};
  els.videoList.querySelector = (sel) => sel === '.empty-sub' ? els.videoList._emptySub : makeEl('div');
  const documentMock = {
    getElementById(id) { return els[id] || makeEl('div'); },
    createElement(tag) { return makeEl(tag); },
    documentElement: { classList: { add() {}, remove() {} }, style: { setProperty() {} } },
    body: { classList: { add() {}, remove() {} }, appendChild() {}, style: { setProperty() {} } },
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') domContentLoadedCb = cb; },
    querySelectorAll() { return []; },
    querySelector() { return makeEl('div'); },
    title: '',
    visibilityState: 'visible',
  };

  const sandbox = {
    document: documentMock,
    chrome: chromeMock,
    window: { location: { hash: '', search: '', href: 'chrome-extension://test/popup.html' }, innerHeight: 600, close() {} },
    location: { hash: '', search: '', href: 'chrome-extension://test/popup.html' },
    navigator: { userAgent: 'node-test' },
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
    console, Promise, JSON, Math, Date, URL, RegExp, String, Number, Boolean, Array, Object,
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  return { sandbox, getDCL: () => domContentLoadedCb };
}

// ---------- 场景执行 ----------
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

async function runScenario(name, tabUrl, execResult) {
  console.log('=== 场景: ' + name + ' (' + tabUrl.slice(0, 60) + ') ===');
  CURRENT_TAB_URL = tabUrl;
  EXEC_RESULT = execResult || TEST_URL;
  sentMessages.length = 0;

  const els = {};
  for (const id of ids) els[id] = makeEl('div');
  const { sandbox, getDCL } = buildSandbox(els);

  try {
    const src = fs.readFileSync(__dirname + '/popup.js', 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'popup.js' });
    ok('popup.js 加载执行无异常');
  } catch (e) {
    bad('popup.js 执行抛错: ' + e.message);
    return;
  }

  const dcl = getDCL();
  if (!dcl) { bad('DOMContentLoaded 未注册'); return; }
  try {
    await dcl();
    ok('DOMContentLoaded 初始化完成');
  } catch (e) {
    bad('初始化抛错: ' + e.message);
    return;
  }

  await new Promise(r => setTimeout(r, 2600));

  const input = els.urlInput.value;
  const startMsg = sentMessages.find(m => m && m.type === 'start-parse');

  if (tabUrl.includes('tiktok.com')) {
    const expectUrl = tabUrl.startsWith('https://www.tiktok.com/@') && tabUrl.includes('/video/')
      ? tabUrl : (execResult || TEST_URL);
    if (input === expectUrl) ok('输入框自动填入链接: ' + input.slice(0, 60));
    else bad('输入框未填入链接，当前值: "' + input + '"');
    if (startMsg && startMsg.urls && startMsg.urls.includes(expectUrl)) ok('已提交 start-parse（含链接）');
    else bad('未提交 start-parse，消息: ' + JSON.stringify(sentMessages));
    if (els.urlInput.value === expectUrl) ok('提交后链接保留（未被清空）');
    else bad('提交后链接被清空: "' + els.urlInput.value + '"');
  } else {
    // 非 TikTok 页：不解析、不提交、显示诊断
    if (input === '') ok('非TikTok页不填入链接');
    else bad('非TikTok页误填入链接: "' + input + '"');
    if (!startMsg) ok('非TikTok页不提交解析');
    else bad('非TikTok页误提交: ' + JSON.stringify(sentMessages));
    const sub = els.videoList.querySelector('.empty-sub');
    if (sub && sub.textContent && sub.textContent.startsWith('检测到:')) ok('诊断显示检测到的标签页');
    else bad('诊断未显示，empty-sub: "' + (sub && sub.textContent) + '"');
  }

  if (els.versionTag.textContent === 'v' + VERSION) ok('版本号显示 v' + VERSION);
  else bad('版本号显示异常: "' + els.versionTag.textContent + '"');
  console.log('');
}

(async () => {
  await runScenario('A. 视频页（直接匹配 URL）', TEST_URL);
  await runScenario('B. 搜索页（executeScript 提取）', SEARCH_URL, TEST_URL);
  await runScenario('C. 非 TikTok 页（不解析+诊断）', OTHER_URL, null);
  console.log('========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail > 0 ? 1 : 0);
})();
