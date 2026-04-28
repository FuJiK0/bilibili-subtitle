// offscreen.js — 音频解码 + WebSocket 通信
// 职责：
//   1. 从 B站 CDN 下载音频（AAC/OPUS in fMP4）
//   2. Web Audio API 解码 → OfflineAudioContext 重采样到 16kHz mono
//   3. 均分为 N 块，每块附带 time_offset
//   4. 顺序发送到 WS（等响应后再发下一块，保证顺序）
//   5. 每块收到结果后立即上报 background（CHUNK_DONE）
//   6. 全部完成后发 ALL_DONE

const LOG = (...a) => console.log("[BiliSub Offscreen]", ...a);
const ERR = (...a) => console.error("[BiliSub Offscreen]", ...a);

const WS_URL = "ws://localhost:8765";
const TARGET_SR = 16000;
const TARGET_CHUNK_SECS = 55;
const OVERLAP_SECS = 1.5;
const MODEL_SWITCH_TIMEOUT_MS = 30000;

// ════════════════════════════════════════════════════════
//  全局任务状态
// ════════════════════════════════════════════════════════

/** @type {WebSocket|null} */
let ws = null;

/** @type {Array<{pcm, timeOffset, chunkId, overlapAfter}>} 待发队列 */
let pendingChunks = [];

let processing = false;
let totalChunks = 5;
let chunksQueued = 0;

/** 已收到响应的 chunk_id 集合（防重复计数） */
let completedChunkIds = new Set();

/** [P2] background 下发的任务版本号，所有回包须携带此 ID 才会被 background 接受 */
let activeSessionId = 0;

/** 用于丢弃旧任务在下载/解码阶段的残留回调 */
let currentLocalSession = 0;

let allDoneSent = false;
let modelSwitchWaiter = null;
let currentModel = "qwen3";

window.addEventListener("pagehide", () => LOG("[Lifecycle] pagehide"));
window.addEventListener("beforeunload", () => LOG("[Lifecycle] beforeunload"));

// ════════════════════════════════════════════════════════
//  消息工具
// ════════════════════════════════════════════════════════

/**
 * 向 background 发送消息，自动附加 sessionId 以供 background 做会话校验
 * @param {object} msg
 */
const sendToBg = (msg) =>
  chrome.runtime.sendMessage({ ...msg, sessionId: activeSessionId });

// ════════════════════════════════════════════════════════
//  WebSocket 模块
// ════════════════════════════════════════════════════════

function connectWS() {
  return new Promise((resolve, reject) => {
    LOG(`[WS] 连接 ${WS_URL}...`);
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      LOG("[WS] 已连接 ✓");
      // WS_STATUS 不携带 sessionId（全局状态，非任务相关）
      chrome.runtime.sendMessage({ type: "WS_STATUS", connected: true });
      resolve();
    };

    ws.onmessage = (e) => {
      LOG(`[WS] 收到响应: ${e.data.slice(0, 200)}`);
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        ERR("[WS] JSON 解析失败:", err);
        processing = false;
        drainQueue();
        return;
      }

      if (data.type === "model_status") {
        handleModelStatus(data);
        return;
      }
      if (!isChunkResult(data)) {
        LOG("[WS] 忽略未知消息类型:", data);
        return;
      }

      const { chunk_id, sentences } = data;
      LOG(
        `[WS] chunk_id=${chunk_id} sessionId=${activeSessionId} | ${sentences?.length ?? 0} 句`,
      );

      // sendToBg 会自动附加当前 activeSessionId，background 侧校验
      sendToBg({ type: "CHUNK_DONE", chunk_id, sentences: sentences ?? [] });
      markChunkCompleted(chunk_id);

      processing = false;
      drainQueue();
    };

    ws.onerror = () => {
      ERR("[WS] 连接错误，请确认 server_mlx.py 已启动");
      chrome.runtime.sendMessage({
        type: "WS_STATUS",
        connected: false,
        error: true,
      });
      // [Fix 2] 用 sendToBg 而非裸 sendMessage，确保 ERROR 携带 sessionId 通过会话隔离校验
      sendToBg({
        type: "ERROR",
        message:
          "WebSocket 连接失败，请确认 server_mlx.py 已启动 (ws://localhost:8765)",
      });
      reject(new Error("WS error"));
    };

    ws.onclose = () => {
      LOG("[WS] 连接已关闭");
      chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false });
      if (
        !allDoneSent &&
        (processing || pendingChunks.length > 0 || completedChunkIds.size > 0)
      ) {
        sendToBg({
          type: "ERROR",
          message: `WebSocket 连接中断（${completedChunkIds.size}/${totalChunks} 块完成）`,
        });
      }
    };
  });
}

/** 判断消息是否为分块转写结果 */
function isChunkResult(data) {
  return Number.isInteger(data?.chunk_id) && Array.isArray(data?.sentences);
}

/** 处理服务端模型切换确认 */
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

/**
 * 标记一个 chunk 完成，全部完成后广播 ALL_DONE
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
    LOG("[WS] 所有块处理完毕，发送 ALL_DONE");
    sendToBg({ type: "ALL_DONE" });
  }
}

/** 等待服务端确认模型切换（带 30s 超时）
 *
 * [Fix 1] modelSwitchWaiter 是单例。若上一个等待还未结束就又调用本函数
 * （快速连续点击、串任务等场景），新 Promise 会覆盖旧句柄，旧 Promise 的
 * resolve/reject 永远不会被调用，导致前一个任务挂起直至超时。
 * 修复：创建新 waiter 前先 reject 并清理已有的 waiter。
 */
function waitForModelSwitch() {
  // 若已有等待中的 waiter，立即以错误拒绝，防止悬挂
  if (modelSwitchWaiter) {
    LOG("[ModelSwitch] 中断上一个未完成的模型切换等待");
    clearTimeout(modelSwitchWaiter.timerId);
    modelSwitchWaiter.reject(new Error("被新任务中断"));
    modelSwitchWaiter = null;
  }

  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      modelSwitchWaiter = null;
      reject(new Error("模型切换超时（30s）"));
    }, MODEL_SWITCH_TIMEOUT_MS);
    modelSwitchWaiter = { resolve, reject, timerId };
  });
}

// ════════════════════════════════════════════════════════
//  音频处理模块
// ════════════════════════════════════════════════════════

async function fetchAudio(url) {
  LOG(`[Audio] 开始下载: ${url.slice(0, 80)}...`);
  const t0 = performance.now();
  const res = await fetch(url, {
    headers: {
      Referer: "https://www.bilibili.com",
      Origin: "https://www.bilibili.com",
    },
  });
  if (!res.ok) throw new Error(`音频下载失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  LOG(
    `[Audio] 下载完成: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB 耗时${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
  return buf;
}

/**
 * 解码音频并重采样到 16kHz mono Float32
 * @returns {Promise<{samples: Float32Array, duration: number}>}
 */
async function decodeAndResample(arrayBuffer) {
  LOG("[Audio] 开始解码（Web Audio API）...");
  const t0 = performance.now();
  const rawCtx = new AudioContext();
  let decoded;
  try {
    decoded = await rawCtx.decodeAudioData(arrayBuffer);
  } finally {
    await rawCtx.close();
  }
  LOG(
    `[Audio] 解码完成: ${decoded.duration.toFixed(1)}s sr=${decoded.sampleRate}Hz ch=${decoded.numberOfChannels} 耗时${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  LOG(`[Audio] 重采样 → ${TARGET_SR}Hz mono...`);
  const t1 = performance.now();
  const outLen = Math.ceil(decoded.duration * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, outLen, TARGET_SR);
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0);
  const resampled = await offCtx.startRendering();
  const samples = resampled.getChannelData(0);
  LOG(
    `[Audio] 重采样完成: ${samples.length} samples 耗时${((performance.now() - t1) / 1000).toFixed(1)}s`,
  );
  return { samples, duration: decoded.duration };
}

// ════════════════════════════════════════════════════════
//  分块与队列模块
// ════════════════════════════════════════════════════════

/**
 * 将 PCM 样本均分为 n 块并推入发送队列
 * 每块末尾追加 OVERLAP_SECS 重叠上下文
 */
function enqueueChunks(samples, duration, n) {
  const chunkLen = Math.floor(samples.length / n);
  const overlapSamp = Math.floor(OVERLAP_SECS * TARGET_SR);
  LOG(
    `[Chunk] 分 ${n} 块，每块约 ${(chunkLen / TARGET_SR).toFixed(1)}s，尾部重叠 ${OVERLAP_SECS}s`,
  );

  for (let i = 0; i < n; i++) {
    const start = i * chunkLen;
    const end = Math.min(
      i === n - 1 ? samples.length : (i + 1) * chunkLen + overlapSamp,
      samples.length,
    );
    const pcm = samples.slice(start, end);
    const timeOffset = (start / samples.length) * duration;
    const overlapAfter =
      i === n - 1 ? 0 : (chunkLen / samples.length) * duration;

    LOG(
      `[Chunk] 入队 chunk ${i}: ${(pcm.length / TARGET_SR).toFixed(1)}s timeOffset=${timeOffset.toFixed(2)}s overlapAfter=${overlapAfter.toFixed(2)}s`,
    );
    pendingChunks.push({ pcm, timeOffset, chunkId: i, overlapAfter });
    chunksQueued++;
  }
}

/** Float32 [-1,1] → Int16 PCM */
function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

/** 从队列取出下一块发送；每次只处理一块，收到响应后再继续（顺序保证） */
function drainQueue() {
  if (processing || pendingChunks.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    LOG("[Queue] WS 未就绪，暂停出队");
    return;
  }

  processing = true;
  const { pcm, timeOffset, chunkId, overlapAfter } = pendingChunks.shift();

  const meta = JSON.stringify({
    type: "chunk_meta",
    chunk_id: chunkId,
    time_offset: timeOffset,
    overlap_after: overlapAfter,
  });
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
 * @param {number} total    - 新任务总分块数
 * @param {number} sessionId - background 下发的任务版本号
 */
function resetProcessingState(total, sessionId) {
  if (modelSwitchWaiter) {
    clearTimeout(modelSwitchWaiter.timerId);
    modelSwitchWaiter = null;
  }
  totalChunks = total;
  pendingChunks = [];
  processing = false;
  chunksQueued = 0;
  completedChunkIds = new Set();
  allDoneSent = false;
  activeSessionId = sessionId; // [P2] 更新会话 ID，后续所有 sendToBg 自动携带
  LOG(`[State] 重置 totalChunks=${total} sessionId=${sessionId}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

// ── PROCESS_AUDIO：启动 ASR 主流程 ────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg._to && msg._to !== "offscreen") return;
  if (msg.type !== "PROCESS_AUDIO") return;

  currentModel = msg.model ?? "qwen3";
  const n = currentModel === "vibevoice" ? 1 : (msg.totalChunks ?? 5);

  // [P2] 保存 background 下发的 sessionId，并递增本地会话版本（用于下载/解码阶段的丢弃检查）
  const localSession = ++currentLocalSession;
  resetProcessingState(n, msg.sessionId ?? 0);

  LOG(
    `[MSG] PROCESS_AUDIO model=${currentModel} chunks=${n} sessionId=${activeSessionId}`,
  );

  (async () => {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) await connectWS();

      LOG(`[MSG] 请求切换模型: ${currentModel}`);
      const switchPromise = waitForModelSwitch();
      ws.send(JSON.stringify({ type: "set_model", model: currentModel }));
      await switchPromise;

      const buf = await fetchAudio(msg.audioUrl);
      const { samples, duration } = await decodeAndResample(buf);

      // 下载/解码是异步的，结束时校验本地会话，防止旧任务继续入队
      if (localSession !== currentLocalSession) {
        LOG(
          `[State] 下载/解码结果已过期（localSession=${localSession} 当前=${currentLocalSession}），丢弃`,
        );
        return;
      }

      if (currentModel !== "vibevoice") {
        const minChunks = Math.ceil(duration / TARGET_CHUNK_SECS);
        if (minChunks > totalChunks) {
          LOG(
            `[Chunk] 动态扩容: ${totalChunks} → ${minChunks} 块（${duration.toFixed(1)}s）`,
          );
          totalChunks = minChunks;
          sendToBg({ type: "CHUNKS_TOTAL", total: totalChunks });
        }
      }

      enqueueChunks(samples, duration, totalChunks);
      drainQueue();
    } catch (err) {
      ERR("处理流程失败:", err.message);
      sendToBg({ type: "ERROR", message: err.message });
    }
  })();

  sendResponse({ ok: true });
  return true;
});

// ── CHECK_WS：popup 探活 ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "CHECK_WS") return;
  LOG("[MSG] CHECK_WS 探活");
  const probe = new WebSocket(WS_URL);
  probe.onopen = () => {
    LOG("[WS] 探活成功");
    chrome.runtime.sendMessage({ type: "WS_STATUS", connected: true });
    probe.close();
  };
  probe.onerror = () => {
    LOG("[WS] 探活失败");
    chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false });
  };
});

LOG("offscreen.js 已加载");
