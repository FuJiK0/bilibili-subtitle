// offscreen.js — 音频解码 + WebSocket 通信

const LOG = (...a) => console.log("[BiliSub Offscreen]", ...a);
const ERR = (...a) => console.error("[BiliSub Offscreen]", ...a);

const WS_URL = "ws://localhost:8765";
const TARGET_SR = 16000;
const TARGET_CHUNK_SECS = 55;
const OVERLAP_SECS = 1.5;
const MODEL_SWITCH_TIMEOUT_MS = 30000;
const TASK_CANCELLED_ERROR = "任务已取消";
const WAITER_REPLACED_ERROR = "被新调用覆盖";

// ════════════════════════════════════════════════════════
//  全局任务状态
// ════════════════════════════════════════════════════════

/** @type {WebSocket|null} */
let ws = null;

/** @type {Array<{pcm, timeOffset, chunkId, overlapAfter}>} */
let pendingChunks = [];

let processing = false;
let totalChunks = 5;
let chunksQueued = 0;
let completedChunkIds = new Set();

/**
 * background 下发的任务版本号。
 * 所有 sendToBg 调用都会快照当前值，background 侧据此过滤过期回包。
 */
let activeSessionId = 0;

/** 本地异步操作（下载/解码）的取消版本号 */
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
 * 向 background 发消息并附加 sessionId。
 * 注意：此函数在调用时读取全局 activeSessionId，
 * ws 回调（onerror/onclose/onmessage）必须使用创建时快照的 boundSessionId，
 * 不能直接调用本函数——见 connectWS 内部的 sendWithSession。
 */
const sendToBg = (msg) =>
  chrome.runtime.sendMessage({ ...msg, sessionId: activeSessionId });

/** 向 background 发消息并绑定指定 sessionId。 */
const sendToBgWithSession = (msg, sessionId) =>
  chrome.runtime.sendMessage({ ...msg, sessionId });

// ════════════════════════════════════════════════════════
//  WebSocket 模块
// ════════════════════════════════════════════════════════

/**
 * 建立 WebSocket 连接。
 *
 * [Fix 2] WS 回调（onerror / onclose / onmessage）绑定创建时的 sessionId 快照
 * （boundSessionId），而不是运行时读取全局 activeSessionId。
 *
 * 原因：新任务调用 resetProcessingState 后 activeSessionId 已推进，
 * 但旧 socket 的 onerror/onclose 可能晚于此时触发，若读全局值会把
 * 旧 socket 的错误挂到新任务上，绕过会话隔离。
 */
function connectWS() {
  // 快照当前 sessionId，整个 socket 生命周期内的回调都使用此值
  const boundSessionId = activeSessionId;

  /** 带绑定 session 的发送辅助，仅供本 socket 的回调使用 */
  const sendBound = (msg) =>
    chrome.runtime.sendMessage({ ...msg, sessionId: boundSessionId });

  return new Promise((resolve, reject) => {
    LOG(`[WS] 连接 ${WS_URL}... (boundSessionId=${boundSessionId})`);
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      LOG("[WS] 已连接 ✓");
      // WS_STATUS 是全局连接状态，不属于任何任务，不需要 sessionId
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
        `[WS] chunk_id=${chunk_id} boundSession=${boundSessionId} | ${sentences?.length ?? 0} 句`,
      );

      // 使用 sendBound：响应属于此 socket 所服务的任务
      sendBound({ type: "CHUNK_DONE", chunk_id, sentences: sentences ?? [] });
      markChunkCompleted(chunk_id, sendBound);

      processing = false;
      drainQueue();
    };

    ws.onerror = () => {
      ERR(`[WS] 连接错误 (boundSessionId=${boundSessionId})`);
      chrome.runtime.sendMessage({
        type: "WS_STATUS",
        connected: false,
        error: true,
      });
      // 使用 sendBound 确保错误归属正确的任务，而非运行时最新的 activeSessionId
      sendBound({
        type: "ERROR",
        message:
          "WebSocket 连接失败，请确认 server_mlx.py 已启动 (ws://localhost:8765)",
      });
      reject(new Error("WS error"));
    };

    ws.onclose = () => {
      LOG(`[WS] 连接已关闭 (boundSessionId=${boundSessionId})`);
      chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false });
      if (
        !allDoneSent &&
        (processing || pendingChunks.length > 0 || completedChunkIds.size > 0)
      ) {
        sendBound({
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
 * 标记一个 chunk 完成；全部完成时广播 ALL_DONE。
 * @param {number}   chunkId
 * @param {function} sendFn - 绑定了正确 sessionId 的发送函数
 */
function markChunkCompleted(chunkId, sendFn) {
  if (completedChunkIds.has(chunkId)) {
    LOG(`[WS] chunk_id=${chunkId} 重复返回，忽略`);
    return;
  }
  completedChunkIds.add(chunkId);
  LOG(`[WS] 进度: ${completedChunkIds.size}/${totalChunks}`);

  if (!allDoneSent && completedChunkIds.size >= totalChunks) {
    allDoneSent = true;
    LOG("[WS] 所有块处理完毕，发送 ALL_DONE");
    sendFn({ type: "ALL_DONE" });
  }
}

/**
 * 等待服务端确认模型切换（带 30s 超时）。
 *
 * modelSwitchWaiter 是单例。waitForModelSwitch 本身有"覆盖前先 reject"的保护，
 * 但实际调用链是 resetProcessingState → waitForModelSwitch，
 * resetProcessingState 必须是真正的取消边界（见下方）。
 */
function waitForModelSwitch() {
  // 次级保护：若 resetProcessingState 未清理干净，这里补一刀
  if (modelSwitchWaiter) {
    LOG("[ModelSwitch] waitForModelSwitch 发现残留 waiter，强制 reject");
    clearTimeout(modelSwitchWaiter.timerId);
    modelSwitchWaiter.reject(new Error(WAITER_REPLACED_ERROR));
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
    `[Audio] 重采样完成: ${samples.length} samples @ ${TARGET_SR}Hz 耗时${((performance.now() - t1) / 1000).toFixed(1)}s`,
  );
  return { samples, duration: decoded.duration };
}

// ════════════════════════════════════════════════════════
//  分块与队列模块
// ════════════════════════════════════════════════════════

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

function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

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
//  任务状态重置（取消边界）
// ════════════════════════════════════════════════════════

/**
 * 重置全部任务状态，为新任务做准备。
 *
 * 这里是任务取消的唯一、明确边界：
 *
 * [Fix 1] modelSwitchWaiter 必须先调用 .reject() 再清空。
 *   之前的写法是 `modelSwitchWaiter = null`，reject 从未被调用，
 *   旧 Promise 会一直挂起直至 30s 超时，超时后还会触发一次错误路径。
 *
 * [Fix 2] activeSessionId 在此更新。connectWS 内的回调用快照值（boundSessionId），
 *   所以旧 socket 的 onerror/onclose 不受此更新影响，不会打到新任务上。
 */
function resetProcessingState(total, sessionId) {
  if (modelSwitchWaiter) {
    LOG(
      `[Reset] reject 旧 modelSwitchWaiter (session 即将从 ${activeSessionId} → ${sessionId})`,
    );
    clearTimeout(modelSwitchWaiter.timerId);
    modelSwitchWaiter.reject(new Error(TASK_CANCELLED_ERROR));
    modelSwitchWaiter = null;
  }
  totalChunks = total;
  pendingChunks = [];
  processing = false;
  chunksQueued = 0;
  completedChunkIds = new Set();
  allDoneSent = false;
  activeSessionId = sessionId;
  LOG(`[State] 重置完成 totalChunks=${total} activeSessionId=${sessionId}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg._to && msg._to !== "offscreen") return;
  if (msg.type !== "PROCESS_AUDIO") return;

  currentModel = msg.model ?? "qwen3";
  const n = currentModel === "vibevoice" ? 1 : (msg.totalChunks ?? 5);
  const taskSessionId = msg.sessionId ?? 0;

  const localSession = ++currentLocalSession;
  resetProcessingState(n, taskSessionId);

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

      if (localSession !== currentLocalSession) {
        LOG(
          `[State] 下载/解码结果已过期（local ${localSession} 当前 ${currentLocalSession}），丢弃`,
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
          sendToBgWithSession({ type: "CHUNKS_TOTAL", total: totalChunks }, taskSessionId);
        }
      }

      enqueueChunks(samples, duration, totalChunks);
      drainQueue();
    } catch (err) {
      if (
        err.message === TASK_CANCELLED_ERROR ||
        err.message === WAITER_REPLACED_ERROR ||
        localSession !== currentLocalSession
      ) {
        LOG(
          `[State] 忽略已取消任务的退出: sessionId=${taskSessionId} local=${localSession} current=${currentLocalSession} reason=${err.message}`,
        );
        return;
      }
      ERR("处理流程失败:", err.message);
      sendToBgWithSession({ type: "ERROR", message: err.message }, taskSessionId);
    }
  })();

  sendResponse({ ok: true });
  return true;
});

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
