// content.js — B站视频页面字幕覆盖层
// YouTube 字幕逻辑：
//   - 根据 video.currentTime 查找当前 cue（词组）
//   - 当前 cue 存在 → 显示；无 cue → 淡出
//   - 每收到新 chunk 即重建 cue 列表，无需等待全部完成

const LOG = (...a) => console.log('[BiliSub Content]', ...a);

// ── 状态 ─────────────────────────────────────────────────
let allWords  = [];
let cues      = [];        // [{start, end, text}]
let container = null;
let textEl    = null;
let rafId     = null;
let isActive  = false;
let lastCueText = '';

// ── 字幕样式常量（可被 popup 设置覆盖） ─────────────────
let fontSize  = 19;
let bgOpacity = 0.72;

// ════════════════════════════════════════════════════════
//  Cue 构建（类 YouTube 分句逻辑）
// ════════════════════════════════════════════════════════

/**
 * 把词列表分组为字幕句（cue）
 *
 * 分句条件（满足任一）：
 *   - 相邻词间隙 > GAP_THRESHOLD（真正的停顿，主要分句依据）
 *   - 当前句字符数 >= MAX_CHARS（防止一行太长，中文约16字≈一行）
 *   - 当前句时长 > MAX_DUR（兜底，防止超长句）
 *
 * ⚠️ 不用词数（word count）分句：
 *   ForcedAligner 对中文输出的"词"粒度不固定（可能1字/词，也可能2-3字/词），
 *   用词数限制会导致句子在任意位置截断。改为统计实际字符数更可靠。
 */
function buildCues(words, {
  gapThreshold = 0.6,   // 停顿阈值：>=0.6s 才分句（原0.9s太宽松，中间停顿会被合并）
  maxChars     = 18,    // 单句最大字符数（中文约18字 ≈ 一行，英文约40字）
  maxDur       = 7.0,   // 单句最长时长（秒）
} = {}) {
  if (!words.length) return [];

  const result = [];
  let group    = [];

  const groupChars = () => group.reduce((s, w) => s + w.word.length, 0);

  const flush = () => {
    if (!group.length) return;
    result.push({
      start: group[0].start,
      end:   group[group.length - 1].end,
      text:  group.map(w => w.word).join(''),
    });
    group = [];
  };

  for (const word of words) {
    const prev = group[group.length - 1];
    const gap  = prev ? word.start - prev.end : 0;
    const dur  = group.length ? word.end - group[0].start : 0;
    const chars = groupChars();

    // 当前词加入后是否会超字符上限
    const wouldOverflow = chars + word.word.length > maxChars;

    if (gap > gapThreshold || wouldOverflow || dur > maxDur) {
      flush();
    }
    group.push(word);
  }
  flush();

  LOG(`[Cue] 构建完成: ${words.length} 词 → ${result.length} 句`);
  if (result.length) {
    LOG(`[Cue] 时间范围: ${result[0].start.toFixed(2)}s → ${result[result.length-1].end.toFixed(2)}s`);
  }
  return result;
}

// ════════════════════════════════════════════════════════
//  DOM 操作
// ════════════════════════════════════════════════════════

function findPlayerRoot() {
  // B站播放器容器（多种版本布局）
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
  if (!root) { LOG('[DOM] 未找到播放器容器，延迟重试'); return; }

  // 保证容器是 relative/absolute
  const ps = getComputedStyle(root);
  if (ps.position === 'static') root.style.position = 'relative';

  container = document.createElement('div');
  container.id = 'bilisub-container';
  container.innerHTML = '<span id="bilisub-text"></span>';
  root.appendChild(container);

  textEl = container.querySelector('#bilisub-text');
  applyStyle();
  LOG('[DOM] 字幕覆盖层已挂载到:', root.className || root.id);
}

function applyStyle() {
  if (!container || !textEl) return;

  // 字号/透明度可由 popup 动态调整
  textEl.style.fontSize         = `${fontSize}px`;
  textEl.style.background       = `rgba(0,0,0,${bgOpacity})`;
}

function removeOverlay() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (container) { container.remove(); container = null; textEl = null; }
  isActive    = false;
  lastCueText = '';
  LOG('[DOM] 字幕覆盖层已移除');
}

// ════════════════════════════════════════════════════════
//  rAF 渲染循环（YouTube 风格）
// ════════════════════════════════════════════════════════

function startLoop() {
  if (rafId) return;
  LOG('[Loop] 启动字幕渲染循环');

  const tick = () => {
    if (!isActive) { rafId = null; return; }

    const video = document.querySelector('video');
    if (video && textEl) {
      const t = video.currentTime;

      // 找当前激活 cue
      let active = cues.find(c => t >= c.start && t <= c.end);

      // ── YouTube 风格"holdover"：当前无 cue，但距下一句 < LEAD_IN 秒时
      //    保持上一句继续显示（防止句间快速闪烁）
      if (!active) {
        const LEAD_IN  = 0.5;   // 下一句开始前 0.5s 内继续显示上句
        const nextCue  = cues.find(c => c.start > t);
        const prevCue  = [...cues].reverse().find(c => c.end <= t);

        if (nextCue && (nextCue.start - t) < LEAD_IN) {
          active = nextCue;                          // 提前显示下一句
        } else if (prevCue && (t - prevCue.end) < LEAD_IN) {
          active = prevCue;                          // 延迟隐藏上一句
        }
      }

      if (active) {
        if (active.text !== lastCueText) {
          textEl.textContent = active.text;
          lastCueText        = active.text;
          container.classList.add('visible');
          LOG(`[Loop] 显示字幕 [${active.start.toFixed(2)}-${active.end.toFixed(2)}s]: 「${active.text}」 @ t=${t.toFixed(2)}s`);
        }
      } else {
        if (lastCueText !== '') {
          container.classList.remove('visible');
          lastCueText = '';
          LOG(`[Loop] 隐藏字幕 @ t=${t.toFixed(2)}s`);
        }
      }
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

// ════════════════════════════════════════════════════════
//  Toast 状态提示（临时显示在视频右上角）
// ════════════════════════════════════════════════════════

let toastEl = null;
function showToast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'bilisub-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent  = msg;
  toastEl.className    = `bilisub-toast-${type}`;
  toastEl.style.opacity = '1';
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 3500);
  LOG(`[Toast] [${type}] ${msg}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  LOG(`[MSG] 收到: type=${msg.type}`);

  // ── 状态通知 ──────────────────────────────────────────
  if (msg.type === 'STATUS') {
    const emojis = { loading: '⏳', processing: '⚙️', error: '❌', ready: '✅' };
    showToast(`${emojis[msg.status] ?? '📢'} ${msg.message}`, msg.status === 'error' ? 'error' : 'info');
    return;
  }

  // ── 收到新词（渐进推送，每 chunk 一次） ───────────────
  if (msg.type === 'WORDS_UPDATE') {
    allWords = msg.words;
    cues     = buildCues(allWords);

    LOG(`[MSG] WORDS_UPDATE: chunk_id=${msg.chunk_id}, 进度=${msg.progress}%, 词=${allWords.length}, 句=${cues.length}`);
    showToast(`字幕转写中... ${msg.progress}%（${allWords.length} 词）`, 'info');

    if (!isActive) {
      isActive = true;
      createOverlay();
      startLoop();
    }
    return;
  }

  // ── 全部完成 ───────────────────────────────────────────
  if (msg.type === 'ALL_DONE') {
    allWords = msg.words;
    cues     = buildCues(allWords);
    LOG(`[MSG] ALL_DONE: 词=${allWords.length}, 句=${cues.length}`);
    showToast(`✅ 字幕生成完毕（共 ${cues.length} 句）`, 'success');
    return;
  }

  // ── 停止字幕 ───────────────────────────────────────────
  if (msg.type === 'STOP') {
    removeOverlay();
    allWords = []; cues = [];
    showToast('字幕已关闭', 'info');
    return;
  }

  // ── 样式设置（来自 popup slider） ─────────────────────
  if (msg.type === 'SET_STYLE') {
    if (msg.fontSize  !== undefined) fontSize  = msg.fontSize;
    if (msg.bgOpacity !== undefined) bgOpacity = msg.bgOpacity;
    applyStyle();
    return;
  }
});

LOG('content.js 已加载');