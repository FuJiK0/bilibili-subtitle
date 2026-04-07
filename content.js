// content.js — B站视频页面字幕覆盖层
// 后端直接返回句级时间戳（text/start/end），前端只负责渲染，不做任何分句逻辑。

const LOG = (...a) => console.log('[BiliSub Content]', ...a);

let cues = [];   // [{text, start, end}]  直接来自后端
let container = null;
let textEl = null;
let listContainer = null; // 字幕列表容器
let rafId = null;
let isActive = false;
let lastCueText = '';
let toastEl = null;

let fontSize = 19;
let bgOpacity = 0.72;

// ════════════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════════════

function findPlayerRoot() {
  return (
    document.querySelector('.bpx-player-video-wrap') ||
    document.querySelector('.bilibili-player-video') ||
    document.querySelector('#bilibili-player') ||
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
  textEl.style.fontSize = `${fontSize}px`;
  textEl.style.background = `rgba(0,0,0,${bgOpacity})`;
}

function removeOverlay() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (container) { container.remove(); container = null; textEl = null; }
  if (listContainer) { listContainer.remove(); listContainer = null; }
  isActive = false; lastCueText = '';
  LOG('[DOM] 字幕层已移除');
}

// ════════════════════════════════════════════════════════
//  列表 DOM
// ════════════════════════════════════════════════════════

function findDanmakuBox() {
  return document.querySelector('#danmaku-box') ||
    document.querySelector('.bpx-player-danmaku-wrap') ||
    document.querySelector('.bpx-player-danmaku') ||
    document.querySelector('.danmaku-box');
}

function initSubtitleListContainer() {
  const dBox = findDanmakuBox();

  listContainer = document.createElement('div');
  listContainer.id = 'bilisub-list-container';
  listContainer.className = 'collapsed';

  const header = document.createElement('div');
  header.id = 'bilisub-list-header';
  header.innerHTML = '<span id="bilisub-list-title" style="margin-right:20px; font-weight:bold;">字幕列表</span><span id="bilisub-list-toggle">展开</span>';
  listContainer.appendChild(header);

  const content = document.createElement('div');
  content.id = 'bilisub-list-content';
  listContainer.appendChild(content);

  header.querySelector('#bilisub-list-toggle').addEventListener('click', () => {
    listContainer.classList.toggle('collapsed');
    const isCol = listContainer.classList.contains('collapsed');
    header.querySelector('#bilisub-list-toggle').textContent = isCol ? '展开' : '隐藏';
  });

  if (dBox && dBox.parentElement) {
    dBox.parentElement.insertBefore(listContainer, dBox);
    LOG('[DOM] 字幕列表已挂载到弹幕列表上方');
  } else {
    document.body.appendChild(listContainer);
    listContainer.classList.add('fixed-fallback');
    LOG('[DOM] 未找到弹幕列表容器，建立悬浮字幕列表');
  }

  if (!document.getElementById('bilisub-list-style')) {
    const style = document.createElement('style');
    style.id = 'bilisub-list-style';
    style.textContent = `
      #bilisub-list-container {
        width: 100%;
        max-height: 300px;
        background: #f4f4f4;
        border-radius: 6px;
        margin-bottom: 10px;
        padding: 5px;
        box-sizing: border-box;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
      }
      #bilisub-list-container:not(.floating-mode),
      #bilisub-list-container.floating-mode:not(.collapsed) {
        min-height: 100px;
      }
      #bilisub-list-header {
        display: none;
        justify-content: space-between;
        align-items: center;
        padding: 2px 4px 6px;
        margin-bottom: 4px;
        border-bottom: 1px solid #ddd;
        font-size: 13px;
        color: #333;
      }
      html[dark] #bilisub-list-header { border-bottom-color: #444; color: #ccc; }
      #bilisub-list-toggle { cursor: pointer; color: #00a1d6; user-select: none; }
      
      /* Only show header button when floating */
      #bilisub-list-container.floating-mode #bilisub-list-header { display: flex; }
      #bilisub-list-container.floating-mode.collapsed #bilisub-list-content { display: none; }
      #bilisub-list-container.floating-mode.collapsed { width: auto; max-width: 180px; }
      
      #bilisub-list-content {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }
      #bilisub-list-content::-webkit-scrollbar { width: 6px; }
      #bilisub-list-content::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
      html[dark] #bilisub-list-content::-webkit-scrollbar-thumb { background: #555; }

      .bilisub-list-item {
        display: flex;
        align-items: flex-start;
        padding: 6px;
        cursor: pointer;
        border-bottom: 1px solid #e0e0e0;
        transition: background 0.2s;
        border-radius: 4px;
        pointer-events: auto;
      }
      .bilisub-list-item:hover { background: #e0e0e0; }
      .bilisub-list-item.active { background: #d0e8f2; }
      .bilisub-list-item-time {
        color: #00a1d6;
        font-size: 12px;
        min-width: 42px;
        flex-shrink: 0;
        margin-right: 8px;
        margin-top: 1px;
      }
      .bilisub-list-item-text {
        font-size: 13px;
        color: #333;
        line-height: 1.5;
        word-break: break-word;
      }
      html[dark] #bilisub-list-container { background: #222; }
      html[dark] .bilisub-list-item { border-bottom: 1px solid #333; }
      html[dark] .bilisub-list-item:hover { background: #333; }
      html[dark] .bilisub-list-item.active { background: #1e3a47; }
      html[dark] .bilisub-list-item-text { color: #ccc; }
      #bilisub-list-container.fixed-fallback {
        position: fixed;
        right: 20px;
        top: 80px;
        width: 300px;
        max-height: 50vh;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      #bilisub-list-container.floating-mode {
        position: absolute;
        right: 20px;
        top: 20px;
        width: 300px;
        max-height: 70%;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        background: rgba(244,244,244,0.95);
      }
      html[dark] #bilisub-list-container.floating-mode { background: rgba(34,34,34,0.95); }
    `;
    document.head.appendChild(style);
  }

  if (!window._bilisubLayoutInterval) {
    window._bilisubLayoutInterval = setInterval(() => {
      if (!listContainer) return;
      const dBox = findDanmakuBox();
      const pc = document.querySelector('.bpx-player-container');

      const isWebFsOrFull = (pc && pc.classList.contains('bpx-state-web-fs')) || document.fullscreenElement !== null;

      if (isWebFsOrFull) {
        const player = document.querySelector('.bpx-player-video-wrap') || document.querySelector('.bilibili-player-video');
        if (player && listContainer.parentElement !== player) {
          player.appendChild(listContainer);
        }
        listContainer.classList.add('floating-mode');
      } else {
        if (dBox && dBox.parentElement && listContainer.nextSibling !== dBox) {
          dBox.parentElement.insertBefore(listContainer, dBox);
        }
        listContainer.classList.remove('floating-mode');
      }
    }, 1000);
  }
}

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '00:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function jumpToTime(start) {
  LOG(`[DOM] jumpToTime: ${start}`);
  const root = document.querySelector('.bpx-player-video-wrap') || document.querySelector('.bilibili-player-video') || document.querySelector('#bilibili-player');
  const v = root ? root.querySelector('video, bwp-video') : (document.querySelector('bwp-video') || document.querySelector('video'));
  if (v) {
    v.currentTime = start;
    const p = v.play();
    if (p && p.catch) p.catch(() => { });
  } else {
    LOG('[DOM] Video not found for seek!');
  }
}

let isUserScrolling = false;
let scrollTimeout = null;

function updateSubtitleList() {
  if (!listContainer) initSubtitleListContainer();
  const contentNode = listContainer.querySelector('#bilisub-list-content');
  if (!contentNode) return;

  if (!contentNode.hasAttribute('data-scroll-bound')) {
    contentNode.addEventListener('wheel', () => {
      isUserScrolling = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => isUserScrolling = false, 3000);
    });
    contentNode.addEventListener('touchstart', () => {
      isUserScrolling = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => isUserScrolling = false, 3000);
    });
    contentNode.setAttribute('data-scroll-bound', 'true');
  }

  const currentCount = contentNode.children.length;
  if (currentCount > cues.length) {
    contentNode.innerHTML = '';
  }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let item = contentNode.children[i];

    if (!item) {
      item = document.createElement('div');
      item.className = 'bilisub-list-item';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'bilisub-list-item-time';

      const textSpan = document.createElement('span');
      textSpan.className = 'bilisub-list-item-text';

      item.appendChild(timeSpan);
      item.appendChild(textSpan);

      contentNode.appendChild(item);
    }

    item.dataset.start = cue.start;
    if (!item.hasAttribute('data-click-bound')) {
      item.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const t = parseFloat(this.dataset.start);
        LOG('[List] 点击跳转到:', t);
        if (!isNaN(t)) jumpToTime(t);
      });
      item.setAttribute('data-click-bound', 'true');
    }

    const timeStr = formatTime(cue.start);
    if (item.children[0].textContent !== timeStr) {
      item.children[0].textContent = timeStr;
    }
    if (item.children[1].textContent !== cue.text) {
      item.children[1].textContent = cue.text;
    }
  }

  while (contentNode.children.length > cues.length) {
    contentNode.removeChild(contentNode.lastChild);
  }

  if (contentNode._lastSubCount !== cues.length) {
    if (!isUserScrolling) {
      contentNode.scrollTop = contentNode.scrollHeight;
    }
    contentNode._lastSubCount = cues.length;
  }
}

function highlightListItem(activeCue) {
  if (!listContainer) return;
  const contentNode = listContainer.querySelector('#bilisub-list-content');
  if (!contentNode) return;
  const index = cues.findIndex(c => c === activeCue);
  if (index === -1) return;

  const currentActive = contentNode.querySelector('.bilisub-list-item.active');
  if (currentActive) currentActive.classList.remove('active');

  const newActive = contentNode.children[index];
  if (newActive) {
    newActive.classList.add('active');
    if (!isUserScrolling) {
      const topPos = newActive.offsetTop;
      contentNode.scrollTop = topPos - contentNode.clientHeight / 2 + newActive.clientHeight / 2;
    }
  }
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
        if (next && (next.start - t) < LEAD) active = next;
        else if (prev && (t - prev.end) < LEAD) active = prev;
      }

      if (active) {
        if (active.text !== lastCueText) {
          textEl.textContent = active.text;
          lastCueText = active.text;
          container.classList.add('visible');
          const idx = cues.indexOf(active);
          const prev = cues[idx - 1];
          const next = cues[idx + 1];
          LOG(`[Cue►] t=${t.toFixed(2)}s | [${active.start.toFixed(2)}-${active.end.toFixed(2)}s] 「${active.text}」`
            + (prev ? ` | 前句间隔=${(active.start - prev.end).toFixed(2)}s` : '')
            + (next ? ` | 后句间隔=${(next.start - active.end).toFixed(2)}s` : ''));
          highlightListItem(active);
        }
      } else if (lastCueText !== '') {
        container.classList.remove('visible');
        LOG(`[Cue◄] 隐藏 @ t=${t.toFixed(2)}s | 最近结束句结束于 `
          + `${[...cues].reverse().find(c => c.end <= t)?.end?.toFixed(2) ?? '?'}s`);
        lastCueText = '';
        if (listContainer) {
          const currentActive = listContainer.querySelector('.bilisub-list-item.active');
          if (currentActive) currentActive.classList.remove('active');
        }
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
  toastEl.textContent = msg;
  toastEl.className = `bilisub-toast-${type}`;
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
    updateSubtitleList();
    if (!isActive) { isActive = true; createOverlay(); startLoop(); }
    return;
  }

  if (msg.type === 'ALL_DONE') {
    cues = msg.sentences ?? msg.words ?? [];
    LOG(`[MSG] ALL_DONE 句=${cues.length}`);
    if (cues.length) LOG(`[MSG] 首句: 「${cues[0].text}」[${cues[0].start}-${cues[0].end}s]`);
    showToast(`✅ 字幕生成完毕（共 ${cues.length} 句）`, 'success');
    updateSubtitleList();
    if (!isActive) { isActive = true; createOverlay(); startLoop(); }
    return;
  }

  if (msg.type === 'STOP') {
    removeOverlay(); cues = [];
    showToast('字幕已关闭', 'info');
    return;
  }

  if (msg.type === 'SET_STYLE') {
    if (msg.fontSize !== undefined) fontSize = msg.fontSize;
    if (msg.bgOpacity !== undefined) bgOpacity = msg.bgOpacity;
    applyStyle();
    return;
  }
});

LOG('content.js 已加载');