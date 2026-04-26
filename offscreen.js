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

const WS_URL     = 'ws://localhost:8765';
const TARGET_SR  = 16000;
const TARGET_CHUNK_SECS = 55;   // 每块目标时长（含重叠后 ≤56.5s，留有余量不超过服务端上限）
const MODEL_SWITCH_TIMEOUT_MS = 30000;

let ws            = null;
let pendingChunks = [];   // {pcm: Float32Array, timeOffset: number, chunkId: number}
let processing    = false;
let totalChunks   = 5;
let chunksQueued  = 0;    // 已送入 pendingChunks 的数量
let chunksReceived = 0;
let completedChunkIds = new Set();
let currentSessionId = 0; // 用于忽略旧任务残留的异步回调
let allDoneSent = false;
let modelSwitchWaiter = null;

// 记录 offscreen 生命周期，便于定位浏览器为何主动关闭文档。
window.addEventListener('pagehide', () => {
  LOG('[Lifecycle] offscreen pagehide');
});
window.addEventListener('beforeunload', () => {
  LOG('[Lifecycle] offscreen beforeunload');
});

// ════════════════════════════════════════════════════════
//  WebSocket
// ════════════════════════════════════════════════════════

function connectWS() {
  return new Promise((resolve, reject) => {
    LOG(`[WS] 连接 ${WS_URL}...`);
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      LOG('[WS] 已连接 ✓');
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true });
      resolve();
    };

    ws.onmessage = (e) => {
      LOG(`[WS] 收到响应: ${e.data.slice(0, 200)}`);
      let data;
      try { data = JSON.parse(e.data); }
      catch (err) { ERR('[WS] JSON 解析失败:', err); processing = false; drainQueue(); return; }

      if (data.type === 'model_status') {
        handleModelStatus(data);
        return;
      }

      if (!isChunkResultMessage(data)) {
        LOG('[WS] 忽略未知消息:', data);
        return;
      }

      const { chunk_id, sentences } = data;
      LOG(`[WS] chunk_id=${chunk_id} | ${sentences?.length ?? 0} 句`);

      chrome.runtime.sendMessage({
        type: 'CHUNK_DONE',
        chunk_id,
        sentences: sentences ?? [],
      });

      markChunkCompleted(chunk_id);

      processing = false;
      drainQueue();
    };

    ws.onerror = (e) => {
      ERR('[WS] 连接错误，请确认 server_mlx.py 已启动');
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false, error: true });
      chrome.runtime.sendMessage({ type: 'ERROR', message: 'WebSocket 连接失败，请确认 server_mlx.py 已启动 (ws://localhost:8765)' });
      reject(new Error('WS error'));
    };

    ws.onclose = () => {
      LOG('[WS] 连接已关闭');
      chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });
      if (!allDoneSent && (processing || pendingChunks.length > 0 || chunksReceived > 0)) {
        chrome.runtime.sendMessage({
          type: 'ERROR',
          message: `WebSocket 连接中断，转写已停止（${chunksReceived}/${totalChunks} 块完成）`,
        });
      }
    };
  });
}

let currentModel   = 'qwen3';   // 跟随 popup 设置

function resetProcessingState(total) {
  if (modelSwitchWaiter) {
    clearTimeout(modelSwitchWaiter.timerId);
    modelSwitchWaiter = null;
  }
  totalChunks = total;
  chunksReceived = 0;
  pendingChunks = [];
  processing = false;
  chunksQueued = 0;
  completedChunkIds = new Set();
  allDoneSent = false;
}

function isChunkResultMessage(data) {
  return Number.isInteger(data?.chunk_id) && Array.isArray(data?.sentences);
}

function handleModelStatus(data) {
  if (!modelSwitchWaiter) return;
  clearTimeout(modelSwitchWaiter.timerId);
  const { resolve, reject } = modelSwitchWaiter;
  modelSwitchWaiter = null;
  if (data.error) {
    reject(new Error(data.error));
    return;
  }
  LOG(`[MSG] 模型确认: ${data.current_model} loading=${data.loading}`);
  resolve(data);
}

function markChunkCompleted(chunkId) {
  if (completedChunkIds.has(chunkId)) {
    LOG(`[WS] chunk_id=${chunkId} 重复返回，忽略计数`);
    return;
  }

  completedChunkIds.add(chunkId);
  chunksReceived = completedChunkIds.size;
  LOG(`[WS] 进度: ${chunksReceived}/${totalChunks}`);

  if (!allDoneSent && chunksReceived >= totalChunks) {
    allDoneSent = true;
    LOG('[WS] 所有块处理完毕，发送 ALL_DONE');
    chrome.runtime.sendMessage({ type: 'ALL_DONE' });
  }
}

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
//  音频下载 & 解码
// ════════════════════════════════════════════════════════

async function fetchAudio(url) {
  LOG(`[Audio] 开始下载: ${url.slice(0, 80)}...`);
  const t0 = performance.now();

  const res = await fetch(url, {
    headers: {
      'Referer': 'https://www.bilibili.com',
      'Origin':  'https://www.bilibili.com',
    },
  });

  if (!res.ok) throw new Error(`音频下载失败 HTTP ${res.status}`);

  const contentLength = res.headers.get('content-length');
  LOG(`[Audio] Content-Length: ${contentLength ? (contentLength/1024/1024).toFixed(1)+'MB' : '未知'}`);

  const buf = await res.arrayBuffer();
  LOG(`[Audio] 下载完成: ${(buf.byteLength/1024/1024).toFixed(1)}MB，耗时 ${((performance.now()-t0)/1000).toFixed(1)}s`);
  return buf;
}

async function decodeAndResample(arrayBuffer) {
  LOG('[Audio] 开始解码（Web Audio API）...');
  const t0 = performance.now();

  // 解码原始格式（AAC / OPUS / etc.）
  const rawCtx = new AudioContext();
  let decoded;
  try {
    decoded = await rawCtx.decodeAudioData(arrayBuffer);
  } finally {
    await rawCtx.close();
  }
  LOG(`[Audio] 解码完成: duration=${decoded.duration.toFixed(1)}s, sr=${decoded.sampleRate}Hz, ch=${decoded.numberOfChannels}，耗时 ${((performance.now()-t0)/1000).toFixed(1)}s`);

  // 重采样到 16kHz mono
  LOG(`[Audio] 重采样到 ${TARGET_SR}Hz mono...`);
  const t1 = performance.now();
  const outLen = Math.ceil(decoded.duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, outLen, TARGET_SR);

  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0);

  const resampled = await offCtx.startRendering();
  const samples   = resampled.getChannelData(0);   // Float32Array
  LOG(`[Audio] 重采样完成: ${samples.length} samples @ ${TARGET_SR}Hz，耗时 ${((performance.now()-t1)/1000).toFixed(1)}s`);

  return { samples, duration: decoded.duration };
}

// ════════════════════════════════════════════════════════
//  分块 & 队列
// ════════════════════════════════════════════════════════

const OVERLAP_SECS = 1.5;   // 每块末尾额外送入后续音频作为上下文

function enqueueChunks(samples, duration, n) {
  const chunkLen    = Math.floor(samples.length / n);
  const overlapSamp = Math.floor(OVERLAP_SECS * TARGET_SR);
  LOG(`[Chunk] 分为 ${n} 块，每块约 ${(chunkLen/TARGET_SR).toFixed(1)}s，重叠 ${OVERLAP_SECS}s`);

  for (let i = 0; i < n; i++) {
    const start      = i * chunkLen;
    const end        = Math.min(i === n - 1 ? samples.length : (i + 1) * chunkLen + overlapSamp, samples.length);
    const pcm        = samples.slice(start, end);
    const timeOffset = (start / samples.length) * duration;
    // 告诉服务端每块的有效时长边界（超出部分为尾部重叠上下文，由下一块负责）
    // 末块没有尾部重叠，overlapAfter=0 表示不截断；其余块均需过滤尾部重叠区
    const overlapAfter = (i === n - 1) ? 0 : (chunkLen / samples.length) * duration;

    LOG(`[Chunk] 入队 chunk ${i}: samples=${pcm.length}(${(pcm.length/TARGET_SR).toFixed(1)}s), timeOffset=${timeOffset.toFixed(2)}s, overlapAfter=${overlapAfter.toFixed(2)}s`);
    pendingChunks.push({ pcm, timeOffset, chunkId: i, overlapAfter });
    chunksQueued++;
  }
}

/** Float32 [-1,1] → Int16 PCM */
function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i]  = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

function drainQueue() {
  if (processing || pendingChunks.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    LOG('[Queue] WS 未就绪，暂停出队');
    return;
  }

  processing = true;
  const { pcm, timeOffset, chunkId, overlapAfter } = pendingChunks.shift();

  // 发送元数据帧
  const meta = JSON.stringify({ type: 'chunk_meta', chunk_id: chunkId, time_offset: timeOffset, overlap_after: overlapAfter });
  LOG(`[Queue] 发送元数据: ${meta}`);
  ws.send(meta);

  // 发送 PCM 二进制帧
  const i16 = float32ToInt16(pcm);
  LOG(`[Queue] 发送 PCM: ${i16.buffer.byteLength} bytes (chunk_id=${chunkId})`);
  ws.send(i16.buffer);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg._to && msg._to !== 'offscreen') return;
  if (msg.type !== 'PROCESS_AUDIO') return;

  currentModel = msg.model ?? 'qwen3';
  // VibeVoice 支持 60 分钟单次推理，发 1 个 chunk；Qwen3 分 5 块
  const n = currentModel === 'vibevoice' ? 1 : (msg.totalChunks ?? 5);
  const sessionId = ++currentSessionId;

  LOG(`[MSG] PROCESS_AUDIO model=${currentModel} chunks=${n}`);
  resetProcessingState(n);

  (async () => {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        await connectWS();
      }

      // 通知服务端切换模型，等待确认
      const modelMsg = JSON.stringify({ type: 'set_model', model: currentModel });
      LOG(`[MSG] 发送 set_model: ${modelMsg}`);
      const modelSwitchPromise = waitForModelSwitch();
      ws.send(modelMsg);
      await modelSwitchPromise;

      const buf = await fetchAudio(msg.audioUrl);
      const { samples, duration } = await decodeAndResample(buf);
      if (sessionId !== currentSessionId) return;

      // 根据实际音频时长动态调整块数，确保每块（含尾部重叠）不超过服务端截断上限
      if (currentModel !== 'vibevoice') {
        const minChunks = Math.ceil(duration / TARGET_CHUNK_SECS);
        if (minChunks > totalChunks) {
          LOG(`[Chunk] 动态扩容: ${totalChunks} → ${minChunks} 块（时长 ${duration.toFixed(1)}s，目标每块≤${TARGET_CHUNK_SECS}s）`);
          totalChunks = minChunks;
          // 通知 background 更新进度分母
          chrome.runtime.sendMessage({ type: 'CHUNKS_TOTAL', total: totalChunks });
        }
      }

      enqueueChunks(samples, duration, totalChunks);
      drainQueue();

    } catch (err) {
      ERR('处理流程失败:', err.message);
      chrome.runtime.sendMessage({ type: 'ERROR', message: err.message });
    }
  })();

  sendResponse({ ok: true });
  return true;
});

// 检测 WS 服务是否在线（popup 打开时触发）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CHECK_WS') return;
  LOG('[MSG] CHECK_WS');

  const probe = new WebSocket(WS_URL);
  probe.onopen  = () => {
    LOG('[WS] 探活成功');
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: true });
    probe.close();
  };
  probe.onerror = () => {
    LOG('[WS] 探活失败');
    chrome.runtime.sendMessage({ type: 'WS_STATUS', connected: false });
  };
});

LOG('offscreen.js 已加载');
