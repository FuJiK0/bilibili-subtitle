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

let ws            = null;
let pendingChunks = [];   // {pcm: Float32Array, timeOffset: number, chunkId: number}
let processing    = false;
let totalChunks   = 5;
let chunksQueued  = 0;    // 已送入 pendingChunks 的数量

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

      const { chunk_id, sentences } = data;
      LOG(`[WS] chunk_id=${chunk_id} | ${sentences?.length ?? 0} 句`);

      chrome.runtime.sendMessage({
        type: 'CHUNK_DONE',
        chunk_id,
        sentences: sentences ?? [],
      });

      // 通知 background 检查是否全部完成
      chunksReceived++;
      LOG(`[WS] 进度: ${chunksReceived}/${totalChunks}`);
      if (chunksReceived >= totalChunks) {
        LOG('[WS] 所有块处理完毕，发送 ALL_DONE');
        chrome.runtime.sendMessage({ type: 'ALL_DONE' });
      }

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
    };
  });
}

let chunksReceived = 0;
let currentModel   = 'qwen3';   // 跟随 popup 设置

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
    // 告诉服务端：只输出 start >= overlapAfter 的句子（即非重叠部分）
    // 第一块没有前置重叠，其余块的真实内容从 chunkLen 处开始
    const overlapAfter = i === 0 ? 0 : (chunkLen / samples.length) * duration;

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

  LOG(`[MSG] PROCESS_AUDIO model=${currentModel} chunks=${n}`);
  totalChunks    = n;
  chunksReceived = 0;
  pendingChunks  = [];
  processing     = false;
  chunksQueued   = 0;

  (async () => {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        await connectWS();
      }

      // 通知服务端切换模型，等待确认
      const modelMsg = JSON.stringify({ type: 'set_model', model: currentModel });
      LOG(`[MSG] 发送 set_model: ${modelMsg}`);
      ws.send(modelMsg);

      await new Promise((resolve, reject) => {
        const tid = setTimeout(() => reject(new Error('模型切换超时（30s）')), 30000);
        const handler = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type === 'model_status') {
              clearTimeout(tid);
              ws.removeEventListener('message', handler);
              if (data.error) { reject(new Error(data.error)); }
              else { LOG(`[MSG] 模型确认: ${data.current_model} loading=${data.loading}`); resolve(); }
            }
          } catch {}
        };
        ws.addEventListener('message', handler);
      });

      const buf = await fetchAudio(msg.audioUrl);
      const { samples, duration } = await decodeAndResample(buf);
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