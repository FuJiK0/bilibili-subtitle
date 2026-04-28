// popup.js — B站字幕插件弹窗控制器
const LOG = (...a) => console.log("[BiliSub Popup]", ...a);

const OFFSCREEN_DOCUMENT_URL = "offscreen.html";
const OFFSCREEN_REASONS = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION =
  "Keep an offscreen document alive for ASR websocket probing";

// ════════════════════════════════════════════════════════
//  DOM 引用
// ════════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);

const wsDot = $("ws-dot");
const wsLabel = $("ws-label");
const urlInput = $("url-input");
const btnGen = $("btn-generate");
const btnSummarize = $("btn-summarize");
const btnStop = $("btn-stop");
const progressSec = $("progress-section");
const progressBar = $("progress-bar");
const progressPct = $("progress-pct");
const progressWords = $("progress-words");
const statusText = $("status-text");
const fontSizeEl = $("font-size");
const fontSizeVal = $("font-size-val");
const bgOpEl = $("bg-opacity");
const bgOpVal = $("bg-opacity-val");

// 总结面板元素
const summaryPanel = $("summary-panel");
const summaryBadge = $("summary-badge");
const summaryContent = $("summary-content");
const summaryAsrProgress = $("summary-asr-progress");
const summaryProgressBar = $("summary-progress-bar");
const summaryProgressLabel = $("summary-progress-label");
const btnSummaryCopy = $("btn-summary-copy");

// ════════════════════════════════════════════════════════
//  可复用 UI 工具
// ════════════════════════════════════════════════════════

/** 更新 WS 状态指示器与按钮可用性 */
function setWsStatus(connected, connecting = false) {
  wsDot.className =
    "ws-dot " + (connecting ? "connecting" : connected ? "connected" : "error");
  wsLabel.textContent = connecting
    ? "检测 ASR 服务中..."
    : connected
      ? "ASR 服务已就绪"
      : "ASR 服务未连接（请启动 server_mlx.py）";
  btnGen.disabled = !connected;
  btnSummarize.disabled = !connected;
  LOG(`[WS] connected=${connected} connecting=${connecting}`);
}

/**
 * 更新字幕提取进度条
 * @param {number} pct   - 0~100
 * @param {number} words - 已转写句数
 */
function setProgress(pct, words) {
  progressSec.classList.add("visible");
  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${pct}%`;
  progressWords.textContent = `${words} 句`;
}

/**
 * 设置底部状态文字
 * @param {string} msg
 * @param {'error'|'done'|''} cls
 */
function setStatus(msg, cls = "") {
  statusText.textContent = msg;
  statusText.className = `status-text ${cls}`;
}

/**
 * 将所有主按钮恢复为可交互状态
 * 用于流程完成或出错后的 UI 重置
 */
function resetActionButtons() {
  btnGen.disabled = false;
  btnSummarize.disabled = false;
  btnStop.classList.remove("visible");
}

// ════════════════════════════════════════════════════════
//  总结面板 UI
// ════════════════════════════════════════════════════════

/**
 * 更新总结面板状态徽章
 * @param {'loading'|'asr'|'summarizing'|'done'|'error'} status
 * @param {string} label
 */
function setSummaryBadge(status, label) {
  summaryBadge.textContent = label;
  summaryBadge.className = "summary-status-badge";
  if (status === "done") summaryBadge.classList.add("done");
  if (status === "error") summaryBadge.classList.add("error");
}

/** 显示总结面板并重置内容 */
function openSummaryPanel() {
  summaryPanel.classList.add("visible");
  summaryContent.textContent = "";
  summaryContent.classList.remove("typing-cursor");
  summaryAsrProgress.classList.remove("visible");
  summaryProgressBar.style.width = "0%";
  LOG("[Summary] 总结面板已打开");
}

/** 追加流式文本到总结面板 */
function appendSummaryChunk(delta) {
  summaryContent.textContent += delta;
  summaryContent.classList.add("typing-cursor");
  // 自动滚动到底部
  summaryContent.scrollTop = summaryContent.scrollHeight;
}

/** 总结完成：停止光标动画 */
function finalizeSummary() {
  summaryContent.classList.remove("typing-cursor");
  summaryAsrProgress.classList.remove("visible");
  LOG("[Summary] 总结显示完毕");
}

// ════════════════════════════════════════════════════════
//  模型选择
// ════════════════════════════════════════════════════════

/** 当前选中的 ASR 模型 */
let selectedModel = "qwen3";

document.querySelectorAll(".model-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".model-tab")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedModel = btn.dataset.model;
    LOG(`模型切换: ${selectedModel}`);
    const hint = $("model-hint");
    if (selectedModel === "vibevoice") {
      hint.textContent =
        "VibeVoice 9B｜首次使用会自动下载（~17GB），请耐心等待";
      hint.style.color = "rgba(251,191,36,0.7)";
    } else {
      hint.textContent =
        "Qwen3: 快速，需 Aligner｜VibeVoice: 9B，自带时间戳，首次需下载";
      hint.style.color = "rgba(255,255,255,0.3)";
    }
  });
});

// ════════════════════════════════════════════════════════
//  BV 号提取工具
// ════════════════════════════════════════════════════════

/**
 * 从字符串中提取 BV 号
 * @param {string} raw - 原始输入（URL 或纯 BV 号）
 * @returns {string|null} 标准化的 BV 号，或 null
 */
function extractBvid(raw) {
  const s = raw.trim();
  if (/^BV[a-zA-Z0-9]+$/i.test(s)) return s;
  const m = s.match(/BV([a-zA-Z0-9]+)/i);
  return m ? `BV${m[1]}` : null;
}

/**
 * 获取当前 Tab 并校验是否为 B站视频页
 * @returns {Promise<chrome.tabs.Tab|null>} 有效 Tab 或 null（已显示错误）
 */
async function getActiveBiliTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("bilibili.com/video")) {
    setStatus("请先打开一个 B站视频页面", "error");
    return null;
  }
  return tab;
}

// ════════════════════════════════════════════════════════
//  生成字幕
// ════════════════════════════════════════════════════════

btnGen.addEventListener("click", async () => {
  const bvid = extractBvid(urlInput.value);
  if (!bvid) {
    setStatus("无法识别 BV 号，请输入完整链接或 BV 号", "error");
    return;
  }

  const tab = await getActiveBiliTab();
  if (!tab) return;

  LOG(`[字幕] 开始生成: bvid=${bvid} tabId=${tab.id}`);

  btnGen.disabled = true;
  btnSummarize.disabled = true;
  btnStop.classList.add("visible");
  setProgress(0, 0);
  setStatus("正在获取音频信息...");

  chrome.runtime.sendMessage(
    { type: "START", bvid, tabId: tab.id, model: selectedModel },
    (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(`发送失败: ${chrome.runtime.lastError.message}`, "error");
        LOG("sendMessage error:", chrome.runtime.lastError.message);
      }
    },
  );
});

// ════════════════════════════════════════════════════════
//  总结视频
// ════════════════════════════════════════════════════════

btnSummarize.addEventListener("click", async () => {
  const bvid = extractBvid(urlInput.value);
  if (!bvid) {
    setStatus("无法识别 BV 号，请输入完整链接或 BV 号", "error");
    return;
  }

  const tab = await getActiveBiliTab();
  if (!tab) return;

  LOG(`[总结] 开始: bvid=${bvid} tabId=${tab.id}`);

  btnGen.disabled = true;
  btnSummarize.disabled = true;
  openSummaryPanel();
  setSummaryBadge("loading", "检测字幕中...");
  setStatus("正在获取视频信息...");

  chrome.runtime.sendMessage(
    { type: "SUMMARIZE", bvid, tabId: tab.id, model: selectedModel },
    (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(`发送失败: ${chrome.runtime.lastError.message}`, "error");
        LOG("sendMessage error:", chrome.runtime.lastError.message);
      }
    },
  );
});

// ── 复制总结内容 ──────────────────────────────────────────
btnSummaryCopy.addEventListener("click", () => {
  const text = summaryContent.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    btnSummaryCopy.textContent = "已复制";
    btnSummaryCopy.classList.add("copied");
    setTimeout(() => {
      btnSummaryCopy.textContent = "复制";
      btnSummaryCopy.classList.remove("copied");
    }, 2000);
    LOG("[Summary] 总结内容已复制到剪贴板");
  });
});

// ════════════════════════════════════════════════════════
//  停止按钮
// ════════════════════════════════════════════════════════

btnStop.addEventListener("click", async () => {
  LOG("用户停止字幕");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "STOP" });
  resetActionButtons();
  progressSec.classList.remove("visible");
  setStatus("字幕已停止");
});

// ════════════════════════════════════════════════════════
//  消息监听（来自 background）
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (msg._to && msg._to !== "popup") return;
  LOG(`[MSG] type=${msg.type}`);

  // ── WS 连接状态 ────────────────────────────────────────
  if (msg.type === "WS_STATUS") {
    setWsStatus(msg.connected, false);
    return;
  }

  // ── 字幕模式：开始处理 ─────────────────────────────────
  if (msg.type === "PROCESSING_START") {
    setStatus(`转写中：${msg.title ?? ""}`);
    return;
  }

  // ── 字幕模式：进度 ─────────────────────────────────────
  if (msg.type === "PROGRESS") {
    setProgress(msg.progress, msg.wordsCount);
    setStatus(`正在转写... ${msg.progress}%（已完成 ${msg.wordsCount} 句）`);
    return;
  }

  // ── 字幕模式：全部完成 ─────────────────────────────────
  if (msg.type === "ALL_DONE") {
    setProgress(100, msg.wordsCount);
    setStatus(`✅ 字幕生成完毕（共 ${msg.wordsCount} 句）`, "done");
    resetActionButtons();
    return;
  }

  // ── 字幕模式：错误 ─────────────────────────────────────
  if (msg.type === "ERROR") {
    setStatus(`❌ ${msg.message}`, "error");
    resetActionButtons();
    return;
  }

  // ── 总结模式：状态更新 ─────────────────────────────────
  if (msg.type === "SUMMARY_STATUS") {
    LOG(`[Summary] 状态: ${msg.status} — ${msg.message}`);
    setStatus(msg.message);
    setSummaryBadge(
      msg.status,
      {
        loading: "准备中",
        asr: "AI 转写",
        summarizing: "AI 总结",
      }[msg.status] ?? msg.status,
    );

    if (msg.status === "asr") {
      // 显示 ASR 进度条
      summaryAsrProgress.classList.add("visible");
    }
    return;
  }

  // ── 总结模式：ASR 进度 ─────────────────────────────────
  if (msg.type === "SUMMARY_PROGRESS") {
    summaryProgressBar.style.width = `${msg.progress}%`;
    summaryProgressLabel.textContent = msg.message ?? `转写中 ${msg.progress}%`;
    LOG(`[Summary] ASR 进度: ${msg.progress}%`);
    return;
  }

  // ── 总结模式：流式文本块 ───────────────────────────────
  if (msg.type === "SUMMARY_CHUNK") {
    appendSummaryChunk(msg.delta);
    return;
  }

  // ── 总结模式：总结完成 ─────────────────────────────────
  if (msg.type === "SUMMARY_DONE") {
    finalizeSummary();
    setSummaryBadge("done", "完成");
    setStatus("✅ 视频总结已生成", "done");
    resetActionButtons();
    LOG(`[Summary] 完成，共 ${msg.text?.length ?? 0} 字`);
    return;
  }

  // ── 总结模式：错误 ─────────────────────────────────────
  if (msg.type === "SUMMARY_ERROR") {
    setSummaryBadge("error", "失败");
    summaryContent.textContent = `❌ ${msg.message}`;
    summaryContent.classList.remove("typing-cursor");
    setStatus(`❌ 总结失败: ${msg.message}`, "error");
    resetActionButtons();
    ERR(`[Summary] 错误: ${msg.message}`);
    return;
  }
});

// ════════════════════════════════════════════════════════
//  显示设置滑块
// ════════════════════════════════════════════════════════

/** 将当前滑块值同步到 content.js */
async function sendStyle() {
  const fontSize = parseInt(fontSizeEl.value);
  const bgOpacity = parseInt(bgOpEl.value) / 100;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab)
    chrome.tabs.sendMessage(tab.id, { type: "SET_STYLE", fontSize, bgOpacity });
}

fontSizeEl.addEventListener("input", () => {
  fontSizeVal.textContent = `${fontSizeEl.value}px`;
  sendStyle();
});
bgOpEl.addEventListener("input", () => {
  bgOpVal.textContent = `${bgOpEl.value}%`;
  sendStyle();
});

// ════════════════════════════════════════════════════════
//  初始化：探活 WS、自动填 BV 号
// ════════════════════════════════════════════════════════

const ERR = (...a) => console.error("[BiliSub Popup]", ...a);

async function init() {
  LOG("popup 初始化，探活 WS...");
  setWsStatus(false, true);

  // 确保 offscreen 存在后发送 CHECK_WS
  try {
    await chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_URL,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      })
      .catch(() => {}); // 已存在时静默忽略

    chrome.runtime.sendMessage({ _to: "offscreen", type: "CHECK_WS" });
  } catch (e) {
    LOG("offscreen 创建失败:", e.message);
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
