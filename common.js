// ============================================================
// TikTok/抖音下载器 v4.0 - 公共函数模块
// background.js 和 popup.js 共享，避免代码重复
// v4.0：移除试用/激活码/每日限额逻辑，全免费、无限下载
// ============================================================

// ---------- 点赞数格式化 ----------
export function formatLikes(n) {
  if (!n || n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 100000000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'W';
  return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
}

// ---------- 日期格式化 ----------
export function formatDate(ts) {
  if (!ts) return '';
  const date = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (isNaN(date.getTime())) return '';
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}.${d}`;
}
