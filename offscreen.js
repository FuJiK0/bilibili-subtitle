// offscreen.js — 音频解码 + WebSocket 通信
// 职责：
//   1. 从 B站 CDN 下载音频（AAC/OPUS in fMP4）
//   2. Web Audio API 解码 → OfflineAudioContext 重采样到 16kHz mono
//   3. 均分为 N 块，每块附带 time_offset
//   4. 顺序发送到 WS（等响应后再发下一块，保证顺序）
//   5. 每块收到结果后立即上报 background（CHUNK_DONE）
//   6. 全部完成后发 ALL_DONE

const LOG = (...a) => console.log('[BiliSub Offscreen]', ...a);
const ERR = (...a) => console.error('[BiliSub Offscreen]', ...a);

const WS_URL                  = 'ws://localhost:8765';
const TARGET_SR               = 16000;   // 目标采样率（Hz）
const TARGET_CHUNK_SECS       = 55;      // 每块目标时长（服务端上限前留余量）
const OVERLAP_SECS            = 1.5;     // 每块尾部重叠音频（提供上下文）
const MODEL_SWITCH_TIMEOUT_MS = 30000;   // 模型切换最长等待时间

// ════════════════════════════════════════════════════════
//  全局任务状态
// ════════════════════════════════════════════════════════

/** @type {WebSocket|null} 当前 WebSocket 连接 */
let ws = null;

/** @type {Array<{pcm:Float32Array, timeOffset:number, chunkId:number, overlapAfter:number}>} */
let pendingChunks = [];

/** 当前是否有分块正在等待服务端响应 */
let processing = false;

/** 本次任务总分块数 */
let totalChunks = 5;

/** 已送入队列的分块数 */
let chunksQueued = 0;

/** 已收到响应的分块 ID 集合（防重复计数） */
let completedChunkIds = new Set();

/** 用于忽略旧任务残留回调的版本号 */
let currentSessionId = 0;

/** 是否已发送 ALL_DONE（防重复） */
let allDoneSent = false;

/** 模型切换等待句柄 */
let modelSwitchWaiter = null;

/** 当前 popup 选择的模型 */
let currentModel = 'qwen3';

// offscreen 生命周期日志，帮助排查浏览器主动回收问题
window.addEventListener('pagehide',     () => LOG('[Lifecycle] pagehide'));
window.addEventListener('beforeunload', () => LOG('[Lifecycle] beforeunload'));

// ════════════════════════════════════════════════════════
//  消息工具
// ════════════════════════════════════════════════════════

/** 向 background 发送消息（统一封装） */
const sendToBg = (msg) => chrome.runtime.sendMessage(msg);

// ════════════════════════════════════════════════════════
//  WebSocket 模块
// ════════════════════════════════════════════════════════

/**
 * 建立 WebSocket 连接并返回连接就绪的 Promise
 * @returns {Promise<void>}
 */
function connectWS() {
  return new Promise((resolve, reject) => {
    LOG(`[WS] 连接 ${WS_URL}...`);
    ws             = new WebSocket(WS_URL);
    ws.binaryType  = 'arraybuffer';

    ws.onopen = () => {
      LOG('[WS] 已连接 ✓');
      sendToBg({ type: 'WS_STATUS', connected: true });
      resolve();
    };

    ws.onmessage = (e) => {
      LOG(`[WS] 收到响应: ${e.data.slice(0, 200)}`);
      let data;
      try { data = JSON.parse(e.data); }
      catch (err) { ERR('[WS] JSON 解析失败:', err); processing = false; drainQueue(); return; }

      // 模型状态回调
      if (data.type === 'model_status') { handleModelStatus(data); return; }

      // 分块转写结果
      if (!isChunkResult(data)) { LOG('[WS] 忽略未知消息类型:', data); return; }

      const { chunk_id, sentences } = data;
      LOG(`[WS] chunk_id=${chunk_id} | ${sentences?.length ?? 0} 句`);

      sendToBg({ type: 'CHUNK_DONE', chunk_id, sentences: sentences ?? [] });
      markChunkCompleted(chunk_id);

      processing = false;
      drainQueue();
    };

    ws.onerror = () => {
      ERR('[WS] 连接错误，请确认 server_mlx.py 已启动');
      sendToBg({ type: 'WS_STATUS', connected: false, error: true });
      sendToBg({ type: 'ERROR', message: 'WebSocket 连接失败，请确认 server_mlx.py 已启动 (ws://localhost:8765)' });
      reject(new Error('WS error'));
    };

    ws.onclose = () => {
      LOG('[WS] 连接已关闭');
      sendToBg({ type: 'WS_STATUS', connected: false });
      if (!allDoneSent && (processing || pendingChunks.length > 0 || completedChunkIds.size > 0)) {
        sendToBg({
          type:    'ERROR',
          message: `WebSocket 连接中断（${completedChunkIds.size}/${totalChunks} 块完成）`,
        });
      }
    };
  });
}

/**
 * 判断消息是否为分块转写结果
 * @param {object} data
 * @returns {boolean}
 */
function isChunkResult(data) {
  return Number.isInteger(data?.chunk_id) && Array.isArray(data?.sentences);
}

/**
 * 处理服务端模型切换确认消息
 * @param {object} data
 */
function handleModelStatus(data) {
  if (!modelSwitchWaiter) return;
  clearTimeout(modelSwitchWaiter.timerId);
  const { resolve, reject } = modelSwitchWaiter;
  modelSwitchWaiter = null;
  if (data.error) { reject(new Error(data.error)); return; }
  LOG(`[MSG] 模型确认: ${data.current_model} loading=${data.loading}`);
  resolve(data);
}

/**
 * 记录分块完成，如全部完成则广播 ALL_DONE
 * @param {number} chunkId
 */
function markChunkCompleted(chunkId) {
  if (completedChunkIds.has(chunkId)) {
    LOG(`[WS] chunk_id=${chunkId} 重复返回，忽略`);
    return;
  }
  completedChunkIds.add(chunkId);
  LOG(`[WS] 进度: ${completedChunkIds.size}/${totalChunks}`);

  if (!allDoneSent && completedChunkIds.size >= totalChunks) {
    allDoneSent = true;
    LOG('[WS] 所有块处理完毕，发送 ALL_DONE');
    sendToBg({ type: 'ALL_DONE' });
  }
}

/**
 * 等待服务端确认模型切换（带超时）
 * @returns {Promise<object>}
 */
function waitForModelSwitch() {
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      modelSwitchWaiter = null;
      reject(new Error('模型切换超时（30s）'));
    }, MODEL_SWITCH_TIMEOUT_MS);
    modelSwitchWaiter = { resolve, reject, timerId };
  });
}

// ════════════════════════════════════════════════════════
//  音频处理模块
// ════════════════════════════════════════════════════════

/**
 * 从 B站 CDN 下载音频二进制数据
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchAudio(url) {
  LOG(`[Audio] 开始下载: ${url.slice(0, 80)}...`);
  const t0  = performance.now();
  const res = await fetch(url, {
    headers: { 'Referer': 'https://www.bilibili.com', 'Origin': 'https://www.bilibili.com' },
  });
  if (!res.ok) throw new Error(`音频下载失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  LOG(`[Audio] 下载完成: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return buf;
}

/**
 * 解码音频并重采样到 16kHz mono Float32
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{samples: Float32Array, duration: number}>}
 */
async function decodeAndResample(arrayBuffer) {
  LOG('[Audio] 开始解码（Web Audio API）...');
  const t0     = performance.now();
  const rawCtx = new AudioContext();
  let decoded;
  try { decoded = await rawCtx.decodeAudioData(arrayBuffer); }
  finally { await rawCtx.close(); }
  LOG(`[Audio] 解码完成: ${decoded.duration.toFixed(1)}s sr=${decoded.sampleRate}Hz ch=${decoded.numberOfChannels} 耗时${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // 重采样到 16kHz mono
  LOG(`[Audio] 重采样 → ${TARGET_SR}Hz mono...`);
  const t1     = performance.now();
  const outLen = Math.ceil(decoded.duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, outLen, TARGET_SR);
  const src    = offCtx.createBufferSource();
  src.buffer   = decoded;
  src.connect(offCtx.destination);
  src.start(0);
  const resampled = await offCtx.startRendering();
  const samples   = resampled.getChannelData(0);
  LOG(`[Audio] 重采样完成: ${samples.length} samples 耗时${((performance.now() - t1) / 1000).toFixed(1)}s`);
  return { samples, duration: decoded.duration };
}

// ════════════════════════════════════════════════════════
//  分块与队列模块
// ════════════════════════════════════════════════════════

/**
 * 将 PCM 样本均分为 n 块并推入发送队列
 * 每块末尾追加 OVERLAP_SECS 的重叠上下文，服务端会按 overlapAfter 截断
 * @param {Float32Array} samples
 * @param {number} duration   - 音频总时长（秒）
 * @param {number} n          - 分块数
 */
function enqueueChunks(samples, duration, n) {
  const chunkLen    = Math.floor(samples.length / n);
  const overlapSamp = Math.floor(OVERLAP_SECS * TARGET_SR);
  LOG(`[Chunk] 分 ${n} 块，每块约 ${(chunkLen / TARGET_SR).toFixed(1)}s，尾部重叠 ${OVERLAP_SECS}s`);

  for (let i = 0; i < n; i++) {
    const start        = i * chunkLen;
    const end          = Math.min(i === n - 1 ? samples.length : (i + 1) * chunkLen + overlapSamp, samples.length);
    const pcm          = samples.slice(start, end);
    const timeOffset   = (start / samples.length) * duration;
    // 非末块：overlapAfter 为本块的有效边界，超出部分由下一块负责
    const overlapAfter = (i === n - 1) ? 0 : (chunkLen / samples.length) * duration;

    LOG(`[Chunk] 入队 chunk ${i}: ${(pcm.length / TARGET_SR).toFixed(1)}s timeOffset=${timeOffset.toFixed(2)}s overlapAfter=${overlapAfter.toFixed(2)}s`);
    pendingChunks.push({ pcm, timeOffset, chunkId: i, overlapAfter });
    chunksQueued++;
  }
}

/**
 * Float32 [-1, 1] → Int16 PCM（WebSocket 二进制帧格式）
 * @param {Float32Array} f32
 * @returns {Int16Array}
 */
function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i]  = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

/**
 * 从队列中取出下一块并发送到 WebSocket
 * 每次只处理一块，收到响应后再调用自身（顺序保证）
 */
function drainQueue() {
  if (processing || pendingChunks.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { LOG('[Queue] WS 未就绪，暂停出队'); return; }

  processing = true;
  const { pcm, timeOffset, chunkId, overlapAfter } = pendingChunks.shift();

  // 先发元数据帧（JSON），再发 PCM 二进制帧
  const meta = JSON.stringify({ type: 'chunk_meta', chunk_id: chunkId, time_offset: timeOffset, overlap_after: overlapAfter });
  LOG(`[Queue] 发送元数据: ${meta}`);
  ws.send(meta);

  const i16 = float32ToInt16(pcm);
  LOG(`[Queue] 发送 PCM: ${i16.buffer.byteLength} bytes (chunk_id=${chunkId})`);
  ws.send(i16.buffer);
}

// ════════════════════════════════════════════════════════
//  任务状态重置
// ════════════════════════════════════════════════════════

/**
 * 重置全部任务状态，为新任务做准备
 * @param {number} total - 新任务的总分块数
 */
function resetProcessingState(total) {
  if (modelSwitchWaiter) { clearTimeout(modelSwitchWaiter.timerId); modelSwitchWaiter = null; }
  totalChunks        = total;
  pendingChunks      = [];
  processing         = false;
  chunksQueued       = 0;
  completedChunkIds  = new Set();
  allDoneSent        = false;
  LOG(`[State] 重置，totalChunks=${total}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

// ── PROCESS_AUDIO：启动 ASR 主流程 ────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg._to && msg._to !== 'offscreen') return;
  if (msg.type !== 'PROCESS_AUDIO') return;

  currentModel      = msg.model ?? 'qwen3';
  // VibeVoice 支持 60 分钟单次推理，只需 1 块
  const n           = currentModel === 'vibevoice' ? 1 : (msg.totalChunks ?? 5);
  const sessionId   = ++currentSessionId;

  LOG(`[MSG] PROCESS_AUDIO model=${currentModel} chunks=${n}`);
  resetProcessingState(n);

  (async () => {
    try {
      // 确保 WS 连接就绪
      if (!ws || ws.readyState !== WebSocket.OPEN) await connectWS();

      // 通知服务端切换模型，等待确认后再下载音频
      LOG(`[MSG] 请求切换模型: ${currentModel}`);
      const switchPromise = waitForModelSwitch();
      ws.send(JSON.stringify({ type: 'set_model', model: currentModel }));
      await switchPromise;

      // 下载并解码音频
      const buf               = await fetchAudio(msg.audioUrl);
      const { samples, duration } = await decodeAndResample(buf);
      if (sessionId !== currentSessionId) { LOG('[State] 旧任务回调，丢弃'); return; }

      // 动态扩容：按实际时长重算分块数，避免单块超服务端截断上限
      if (currentModel !== 'vibevoice') {
        const minChunks = Math.ceil(duration / TARGET_CHUNK_SECS);
        if (minChunks > totalChunks) {
          LOG(`[Chunk] 动态扩容: ${totalChunks} → ${minChunks} 块（${duration.toFixed(1)}s）`);
          totalChunks = minChunks;
          sendToBg({ type: 'CHUNKS_TOTAL', total: totalChunks }); // 通知 background 更新分母
        }
      }

      enqueueChunks(samples, duration, totalChunks);
      drainQueue();

    } catch (err) {
      ERR('处理流程失败:', err.message);
      sendToBg({ type: 'ERROR', message: err.message });
    }
  })();

  sendResponse({ ok: true });
  return true;
});

// ── CHECK_WS：popup 探活 ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CHECK_WS') return;
  LOG('[MSG] CHECK_WS 探活');
  const probe = new WebSocket(WS_URL);
  probe.onopen  = () => { LOG('[WS] 探活成功'); sendToBg({ type: 'WS_STATUS', connected: true  }); probe.close(); };
  probe.onerror = () => { LOG('[WS] 探活失败'); sendToBg({ type: 'WS_STATUS', connected: false }); };
});

LOG('offscreen.js 已加载');