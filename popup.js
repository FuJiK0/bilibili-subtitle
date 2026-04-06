// popup.js
const LOG = (...a) => console.log('[BiliSub Popup]', ...a);

// ── DOM refs ──────────────────────────────────────────────
const wsDot      = document.getElementById('ws-dot');
const wsLabel    = document.getElementById('ws-label');
const urlInput   = document.getElementById('url-input');
const btnGen     = document.getElementById('btn-generate');
const btnStop    = document.getElementById('btn-stop');
const progressSec = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressPct = document.getElementById('progress-pct');
const progressWords = document.getElementById('progress-words');
const statusText = document.getElementById('status-text');
const fontSizeEl  = document.getElementById('font-size');
const fontSizeVal = document.getElementById('font-size-val');
const bgOpEl      = document.getElementById('bg-opacity');
const bgOpVal     = document.getElementById('bg-opacity-val');

// ── BV 提取 ──────────────────────────────────────────────
function extractBvid(raw) {
  const s = raw.trim();
  if (/^BV[a-zA-Z0-9]+$/i.test(s)) return s;
  const m = s.match(/BV([a-zA-Z0-9]+)/i);
  return m ? `BV${m[1]}` : null;
}

// ── WS 状态 UI ────────────────────────────────────────────
function setWsStatus(connected, connecting = false) {
  wsDot.className = 'ws-dot ' + (connecting ? 'connecting' : connected ? 'connected' : 'error');
  wsLabel.textContent = connecting ? '检测 ASR 服务中...'
                      : connected  ? 'ASR 服务已就绪'
                      :              'ASR 服务未连接（请启动 server_mlx.py）';
  btnGen.disabled = !connected;
  LOG(`[WS] connected=${connected}`);
}

// ── 进度 UI ───────────────────────────────────────────────
function setProgress(pct, words) {
  progressSec.classList.add('visible');
  progressBar.style.width  = `${pct}%`;
  progressPct.textContent  = `${pct}%`;
  progressWords.textContent = `${words} 词`;
}

function setStatus(msg, cls = '') {
  statusText.textContent = msg;
  statusText.className   = `status-text ${cls}`;
}

// ── 生成字幕 ─────────────────────────────────────────────
btnGen.addEventListener('click', async () => {
  const bvid = extractBvid(urlInput.value);
  if (!bvid) {
    setStatus('无法识别 BV 号，请输入完整链接或 BV 号', 'error');
    return;
  }
  LOG(`开始生成字幕: ${bvid}`);

  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('bilibili.com/video')) {
    setStatus('请先打开一个 B站视频页面', 'error');
    return;
  }

  btnGen.disabled = true;
  btnStop.classList.add('visible');
  setProgress(0, 0);
  setStatus('正在获取音频信息...');

  chrome.runtime.sendMessage({ type: 'START', bvid, tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(`发送失败: ${chrome.runtime.lastError.message}`, 'error');
      LOG('sendMessage error:', chrome.runtime.lastError.message);
    }
  });
});

// ── 停止 ─────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  LOG('用户停止字幕');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'STOP' });
  btnGen.disabled = false;
  btnStop.classList.remove('visible');
  progressSec.classList.remove('visible');
  setStatus('字幕已停止');
});

// ── 消息监听（来自 background） ──────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg._to && msg._to !== 'popup') return;

  LOG(`[MSG] type=${msg.type}`);

  if (msg.type === 'WS_STATUS') {
    setWsStatus(msg.connected, false);
    return;
  }

  if (msg.type === 'PROCESSING_START') {
    setStatus(`转写中：${msg.title ?? ''}`);
    return;
  }

  if (msg.type === 'PROGRESS') {
    setProgress(msg.progress, msg.wordsCount);
    setStatus(`正在转写... ${msg.progress}%（已完成 ${msg.wordsCount} 词）`);
    return;
  }

  if (msg.type === 'ALL_DONE') {
    setProgress(100, msg.wordsCount);
    setStatus(`✅ 字幕生成完毕（共 ${msg.wordsCount} 词）`, 'done');
    btnGen.disabled = false;
    return;
  }

  if (msg.type === 'ERROR') {
    setStatus(`❌ ${msg.message}`, 'error');
    btnGen.disabled = false;
    btnStop.classList.remove('visible');
    return;
  }
});

// ── 显示设置滑块 ──────────────────────────────────────────
async function sendStyle() {
  const fontSize  = parseInt(fontSizeEl.value);
  const bgOpacity = parseInt(bgOpEl.value) / 100;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'SET_STYLE', fontSize, bgOpacity });
}

fontSizeEl.addEventListener('input', () => {
  fontSizeVal.textContent = `${fontSizeEl.value}px`;
  sendStyle();
});
bgOpEl.addEventListener('input', () => {
  bgOpVal.textContent = `${bgOpEl.value}%`;
  sendStyle();
});

// ── 初始化：探活 WS ───────────────────────────────────────
async function init() {
  LOG('popup 初始化，探活 WS...');
  setWsStatus(false, true);

  // 确保 offscreen 存在后发送 CHECK_WS
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'WS probe',
    }).catch(() => {}); // 可能已存在，忽略错误

    chrome.runtime.sendMessage({ _to: 'offscreen', type: 'CHECK_WS' });
  } catch (e) {
    LOG('offscreen 创建失败:', e.message);
  }

  // 自动填入当前标签页的 BV 号
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    const bvid = extractBvid(tab.url);
    if (bvid) {
      urlInput.value = bvid;
      LOG(`自动填入 BV 号: ${bvid}`);
    }
  }
}

init();
