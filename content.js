// content.js — B站视频页面字幕覆盖层
// 后端直接返回句级时间戳（text/start/end），前端只负责渲染，不做任何分句逻辑。

const LOG = (...a) => console.log('[BiliSub Content]', ...a);

let cues        = [];   // [{text, start, end}]  直接来自后端
let container   = null;
let textEl      = null;
let rafId       = null;
let isActive    = false;
let lastCueText = '';
let toastEl     = null;

let fontSize  = 19;
let bgOpacity = 0.72;

// ════════════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════════════

function findPlayerRoot() {
  return (
    document.querySelector('.bpx-player-video-wrap')  ||
    document.querySelector('.bilibili-player-video')   ||
    document.querySelector('#bilibili-player')          ||
    document.querySelector('video')?.closest('[class*="player"]') ||
    document.querySelector('video')?.parentElement
  );
}

function createOverlay() {
  if (container) return;
  const root = findPlayerRoot();
  if (!root) { LOG('[DOM] 未找到播放器容器'); return; }
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';

  container = document.createElement('div');
  container.id = 'bilisub-container';
  container.innerHTML = '<span id="bilisub-text"></span>';
  root.appendChild(container);
  textEl = container.querySelector('#bilisub-text');
  applyStyle();
  LOG('[DOM] 字幕层已挂载:', root.className || root.id);
}

function applyStyle() {
  if (!textEl) return;
  textEl.style.fontSize   = `${fontSize}px`;
  textEl.style.background = `rgba(0,0,0,${bgOpacity})`;
}

function removeOverlay() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (container) { container.remove(); container = null; textEl = null; }
  isActive = false; lastCueText = '';
  LOG('[DOM] 字幕层已移除');
}

// ════════════════════════════════════════════════════════
//  rAF 渲染循环（YouTube 风格）
// ════════════════════════════════════════════════════════

function startLoop() {
  if (rafId) return;
  LOG('[Loop] 启动');

  const tick = () => {
    if (!isActive) { rafId = null; return; }

    const video = document.querySelector('video');
    if (video && textEl) {
      const t = video.currentTime;

      let active = cues.find(c => t >= c.start && t <= c.end);

      // Holdover：句间空隙 < 0.5s 时桥接上/下句，避免闪烁
      if (!active) {
        const LEAD = 0.5;
        const next = cues.find(c => c.start > t);
        const prev = [...cues].reverse().find(c => c.end <= t);
        if (next && (next.start - t) < LEAD)    active = next;
        else if (prev && (t - prev.end) < LEAD) active = prev;
      }

      if (active) {
        if (active.text !== lastCueText) {
          textEl.textContent = active.text;
          lastCueText        = active.text;
          container.classList.add('visible');
          LOG(`[Loop] 显示 [${active.start.toFixed(2)}-${active.end.toFixed(2)}s]: 「${active.text}」 @ t=${t.toFixed(2)}s`);
        }
      } else if (lastCueText !== '') {
        container.classList.remove('visible');
        lastCueText = '';
        LOG(`[Loop] 隐藏 @ t=${t.toFixed(2)}s`);
      }
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════

function showToast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'bilisub-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent   = msg;
  toastEl.className     = `bilisub-toast-${type}`;
  toastEl.style.opacity = '1';
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 3500);
  LOG(`[Toast] [${type}] ${msg}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  LOG(`[MSG] type=${msg.type}`);

  if (msg.type === 'STATUS') {
    const e = { loading: '⏳', processing: '⚙️', error: '❌', ready: '✅' };
    showToast(`${e[msg.status] ?? '📢'} ${msg.message}`, msg.status === 'error' ? 'error' : 'info');
    return;
  }

  if (msg.type === 'WORDS_UPDATE') {
    cues = msg.sentences ?? msg.words ?? [];
    LOG(`[MSG] WORDS_UPDATE chunk=${msg.chunk_id} 进度=${msg.progress}% 句=${cues.length}`);
    showToast(`字幕转写中... ${msg.progress}%（${cues.length} 句）`, 'info');
    if (!isActive) { isActive = true; createOverlay(); startLoop(); }
    return;
  }

  if (msg.type === 'ALL_DONE') {
    cues = msg.sentences ?? msg.words ?? [];
    LOG(`[MSG] ALL_DONE 句=${cues.length}`);
    if (cues.length) LOG(`[MSG] 首句: 「${cues[0].text}」[${cues[0].start}-${cues[0].end}s]`);
    showToast(`✅ 字幕生成完毕（共 ${cues.length} 句）`, 'success');
    return;
  }

  if (msg.type === 'STOP') {
    removeOverlay(); cues = [];
    showToast('字幕已关闭', 'info');
    return;
  }

  if (msg.type === 'SET_STYLE') {
    if (msg.fontSize  !== undefined) fontSize  = msg.fontSize;
    if (msg.bgOpacity !== undefined) bgOpacity = msg.bgOpacity;
    applyStyle();
    return;
  }
});

LOG('content.js 已加载');