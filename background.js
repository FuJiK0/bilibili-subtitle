// background.js — B站字幕 Service Worker
// 职责：
//   1. 接收 popup 的 START 指令
//   2. 调用 B站 API 获取音频 URL
//   3. 启动 offscreen 文档，传递音频 URL
//   4. 转发 offscreen 的 CHUNK_DONE → content.js（渐进推送）
//   5. 维护 WS 状态 → popup

const LOG = (...a) => console.log('[BiliSub BG]', ...a);
const ERR = (...a) => console.error('[BiliSub BG]', ...a);

const TOTAL_CHUNKS = 5;   // 把音频分成几块顺序处理

let state = {
  activeTabId: null,
  allWords:    [],          // 所有 chunk 的词，按 start 排序
  chunksReceived: 0,
};

// ════════════════════════════════════════════════════════
//  B站 API
// ════════════════════════════════════════════════════════

/** BV 号 → 视频元数据（包含 cid） */
async function getVideoInfo(bvid) {
  LOG(`[API] 获取视频信息: ${bvid}`);
  const res = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} 获取视频信息`);
  const data = await res.json();
  LOG(`[API] 视频信息返回 code=${data.code}`);
  if (data.code !== 0) throw new Error(`B站API: ${data.message} (code=${data.code})`);
  LOG(`[API] 视频标题: ${data.data.title} | cid: ${data.data.cid}`);
  return data.data;   // .cid, .title, .duration, ...
}

/** bvid + cid → 最高码率的纯音频流 URL */
async function getAudioStreamUrl(bvid, cid) {
  LOG(`[API] 获取 DASH 播放地址: bvid=${bvid}, cid=${cid}`);
  const res = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} 获取播放地址`);
  const data = await res.json();
  LOG(`[API] 播放地址返回 code=${data.code}`);
  if (data.code !== 0) throw new Error(`B站API: ${data.message} (code=${data.code})`);

  const audios = data.data?.dash?.audio;
  if (!audios || audios.length === 0) throw new Error('未找到音频流（可能需要登录或视频无音频）');

  // 按码率降序选最高质量
  audios.sort((a, b) => b.bandwidth - a.bandwidth);
  const best = audios[0];
  const url  = best.baseUrl || best.base_url || best.backupUrl?.[0];
  if (!url) throw new Error('音频流 URL 为空');

  LOG(`[API] 选择音频流: codec=${best.codecs ?? '?'} bandwidth=${best.bandwidth} url前80字符=${url.slice(0, 80)}`);
  return url;
}

// ════════════════════════════════════════════════════════
//  Offscreen 文档管理
// ════════════════════════════════════════════════════════

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    LOG('[Offscreen] 创建 offscreen 文档');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Decode and resample Bilibili audio for ASR',
    });
    LOG('[Offscreen] offscreen 文档已创建');
  } else {
    LOG('[Offscreen] offscreen 文档已存在，复用');
  }
}

// ════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════

async function startProcessing(bvid, tabId) {
  LOG(`==== startProcessing: bvid=${bvid} tabId=${tabId} ====`);
  state = { activeTabId: tabId, allWords: [], chunksReceived: 0 };

  const notifyTab     = (msg) => chrome.tabs.sendMessage(tabId, msg).catch(e => LOG('tabs.msg err:', e.message));
  const notifyPopup   = (msg) => chrome.runtime.sendMessage({ _to: 'popup', ...msg }).catch(() => {});

  notifyTab({ type: 'STATUS', status: 'loading', message: '正在获取视频信息...' });

  try {
    // 1. 获取视频信息
    const info     = await getVideoInfo(bvid);
    const audioUrl = await getAudioStreamUrl(bvid, info.cid);

    notifyTab({ type: 'STATUS', status: 'processing', message: '下载并解码音频中...' });
    notifyPopup({ type: 'PROCESSING_START', title: info.title });

    // 2. 启动 offscreen，让它负责下载/解码/分块/WS 交互
    await ensureOffscreen();

    LOG(`[BG] 发送 PROCESS_AUDIO 到 offscreen`);
    chrome.runtime.sendMessage({
      _to:         'offscreen',
      type:        'PROCESS_AUDIO',
      audioUrl,
      totalChunks: TOTAL_CHUNKS,
    });

  } catch (err) {
    ERR(`startProcessing 失败: ${err.message}`);
    notifyTab({ type: 'STATUS', status: 'error', message: err.message });
    notifyPopup({ type: 'ERROR', message: err.message });
  }
}

// ════════════════════════════════════════════════════════
//  消息路由
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 不属于 background 的消息，忽略
  if (msg._to && msg._to !== 'background') return;

  LOG(`[MSG] type=${msg.type} from=${sender.url?.slice(0, 60) ?? 'unknown'}`);

  // ── popup → START ──────────────────────────────────
  if (msg.type === 'START') {
    startProcessing(msg.bvid, msg.tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── offscreen → CHUNK_DONE ─────────────────────────
  if (msg.type === 'CHUNK_DONE') {
    const { chunk_id, words } = msg;
    LOG(`[CHUNK_DONE] chunk_id=${chunk_id} | ${words.length} 词`);

    // 合并并按时间排序
    state.allWords.push(...words);
    state.allWords.sort((a, b) => a.start - b.start);
    state.chunksReceived++;

    const progress = Math.round((state.chunksReceived / TOTAL_CHUNKS) * 100);
    LOG(`[CHUNK_DONE] 进度 ${state.chunksReceived}/${TOTAL_CHUNKS} = ${progress}%，总词数: ${state.allWords.length}`);

    // 立即推送到 content.js（渐进显示）
    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, {
        type:     'WORDS_UPDATE',
        words:    state.allWords,
        chunk_id,
        progress,
      }).catch(e => LOG('content msg err:', e.message));
    }

    // 更新 popup 进度
    chrome.runtime.sendMessage({
      _to:        'popup',
      type:       'PROGRESS',
      progress,
      wordsCount: state.allWords.length,
    }).catch(() => {});

    return true;
  }

  // ── offscreen → ALL_DONE ───────────────────────────
  if (msg.type === 'ALL_DONE') {
    LOG(`[ALL_DONE] 全部处理完毕，共 ${state.allWords.length} 词`);

    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, {
        type:  'ALL_DONE',
        words: state.allWords,
      }).catch(e => LOG('content msg err:', e.message));
    }

    chrome.runtime.sendMessage({
      _to:        'popup',
      type:       'ALL_DONE',
      wordsCount: state.allWords.length,
    }).catch(() => {});

    return true;
  }

  // ── offscreen → WS_STATUS ─────────────────────────
  if (msg.type === 'WS_STATUS') {
    LOG(`[WS_STATUS] connected=${msg.connected}`);
    chrome.runtime.sendMessage({ _to: 'popup', ...msg }).catch(() => {});
    return true;
  }

  // ── offscreen / any → ERROR ───────────────────────
  if (msg.type === 'ERROR') {
    ERR(`[ERROR] ${msg.message}`);
    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, {
        type: 'STATUS', status: 'error', message: msg.message,
      }).catch(() => {});
    }
    chrome.runtime.sendMessage({ _to: 'popup', type: 'ERROR', message: msg.message }).catch(() => {});
    return true;
  }
});

LOG('Background service worker 已启动');
