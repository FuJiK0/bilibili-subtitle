// background.js — B站字幕 Service Worker
// 职责：
//   1. 接收 popup 的 START / SUMMARIZE 指令
//   2. 调用 B站 API 获取音频 URL / 字幕列表
//   3. 启动 offscreen 文档，传递音频 URL（ASR 路径）
//   4. 转发 offscreen 的 CHUNK_DONE → content.js（渐进推送）
//   5. 维护 WS 状态 → popup
//   6. 视频总结：有官方字幕直接使用，无则先 ASR 再总结

const LOG = (...a) => console.log("[BiliSub BG]", ...a);
const ERR = (...a) => console.error("[BiliSub BG]", ...a);

const OFFSCREEN_DOCUMENT_URL = "offscreen.html";
const OFFSCREEN_REASONS = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION =
  "Decode audio and maintain a long-lived offscreen document for ASR";
const TOTAL_CHUNKS = 5; // ASR 默认分块数

// ════════════════════════════════════════════════════════
//  消息工具模块
//  统一封装 sendMessage，避免调用处散落 .catch 处理
// ════════════════════════════════════════════════════════
const Msg = {
  /**
   * 向指定 Tab 的 content.js 发送消息
   * @param {number} tabId
   * @param {object} msg
   */
  toTab: (tabId, msg) =>
    chrome.tabs
      .sendMessage(tabId, msg)
      .catch((e) => LOG("→tab err:", e.message)),

  /**
   * 向 popup 广播消息（popup 未开启时静默失败）
   * @param {object} msg
   */
  toPopup: (msg) =>
    chrome.runtime.sendMessage({ _to: "popup", ...msg }).catch(() => {}),
};

// ════════════════════════════════════════════════════════
//  B站 API 模块
//  封装所有与 bilibili.com 接口的交互
// ════════════════════════════════════════════════════════
const BiliAPI = {
  /**
   * BV 号 → 视频元数据（包含 cid / title / duration）
   * @param {string} bvid
   * @returns {Promise<object>} data.data
   */
  async getVideoInfo(bvid) {
    LOG(`[BiliAPI] getVideoInfo: ${bvid}`);
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { credentials: "include" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} 获取视频信息`);
    const data = await res.json();
    if (data.code !== 0)
      throw new Error(`B站API: ${data.message} (code=${data.code})`);
    LOG(
      `[BiliAPI] 视频「${data.data.title}」 cid=${data.data.cid} duration=${data.data.duration}s`,
    );
    return data.data; // .cid, .title, .duration, ...
  },

  /**
   * bvid + cid → 最高码率纯音频流 URL
   * @param {string} bvid
   * @param {number} cid
   * @returns {Promise<string>} 音频 URL
   */
  async getAudioStreamUrl(bvid, cid) {
    LOG(`[BiliAPI] getAudioStreamUrl: bvid=${bvid} cid=${cid}`);
    const res = await fetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`,
      { credentials: "include" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} 获取播放地址`);
    const data = await res.json();
    if (data.code !== 0)
      throw new Error(`B站API: ${data.message} (code=${data.code})`);

    const audios = data.data?.dash?.audio;
    if (!audios?.length)
      throw new Error("未找到音频流（可能需要登录或视频无音频）");

    // 按码率降序选最高质量
    audios.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = audios[0];
    const url = best.baseUrl || best.base_url || best.backupUrl?.[0];
    if (!url) throw new Error("音频流 URL 为空");
    LOG(
      `[BiliAPI] 音频流: codec=${best.codecs ?? "?"} bandwidth=${best.bandwidth}`,
    );
    return url;
  },

  /**
   * bvid + cid → 官方字幕列表（可能为空数组）
   * 每项包含 { lan, lan_doc, subtitle_url }
   * @param {string} bvid
   * @param {number} cid
   * @returns {Promise<Array>}
   */
  async getSubtitleList(bvid, cid) {
    LOG(`[BiliAPI] getSubtitleList: bvid=${bvid} cid=${cid}`);
    const res = await fetch(
      `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      LOG(`[BiliAPI] 字幕接口 HTTP ${res.status}，视为无字幕`);
      return [];
    }
    const data = await res.json();
    if (data.code !== 0) {
      LOG(`[BiliAPI] 字幕API code=${data.code}，视为无字幕`);
      return [];
    }
    const subtitles = data.data?.subtitle?.subtitles ?? [];
    LOG(
      `[BiliAPI] 字幕数量: ${subtitles.length}`,
      subtitles.map((s) => s.lan_doc),
    );
    return subtitles;
  },

  /**
   * 下载 B站字幕 JSON，返回纯文本（行拼接，保留时序）
   * 字幕 JSON 格式：{ body: [{from, to, content}] }
   * @param {string} subtitleUrl
   * @returns {Promise<string>} 字幕纯文本
   */
  async downloadSubtitleText(subtitleUrl) {
    // B站字幕 URL 有时以 // 开头，需补全协议
    const url = subtitleUrl.startsWith("//")
      ? `https:${subtitleUrl}`
      : subtitleUrl;
    LOG(`[BiliAPI] 下载字幕: ${url.slice(0, 80)}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} 下载字幕`);
    const data = await res.json();
    const lines = (data.body ?? [])
      .map((item) => item.content?.trim())
      .filter(Boolean);
    LOG(`[BiliAPI] 字幕解析完成: ${lines.length} 行`);
    return lines.join("\n");
  },
};

// ════════════════════════════════════════════════════════
//  本地 LLM 总结模块
//  通过 OpenAI-compatible API 调用本地模型进行视频总结
// ════════════════════════════════════════════════════════
const SummaryAPI = {
  /** 本地 LLM 服务地址（OpenAI-compatible） */
  BASE_URL: "http://127.0.0.1:8000/v1",

  /**
   * 构建总结 prompt
   * @param {string} subtitleText
   * @returns {string}
   */
  buildPrompt(subtitleText) {
    return `请根据以下视频字幕内容，用中文生成一份简洁的视频总结。要求：
1. 先用 1-2 句话概括视频主旨
2. 列出 3-5 个核心要点（用 • 符号开头）
3. 如有结论或建议，简要说明

字幕内容：
${subtitleText}`;
  },

  /**
   * 流式调用本地 LLM 总结字幕文本
   * @param {string} subtitleText - 待总结的字幕/转写文本
   * @param {function} onChunk   - 流式回调 (delta: string) => void
   * @param {function} onDone    - 完成回调 (fullText: string) => void
   * @returns {Promise<void>}
   */
  async summarize(subtitleText, onChunk, onDone) {
    const prompt = this.buildPrompt(subtitleText);
    LOG(`[SummaryAPI] 发起请求，prompt 长度: ${prompt.length} 字符`);

    const res = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "default", // 本地服务通常不限 model 名称
        messages: [{ role: "user", content: prompt }],
        stream: true,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) throw new Error(`总结 API HTTP ${res.status}`);

    LOG("[SummaryAPI] 开始流式读取...");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value, { stream: true });
      // SSE 格式：每行 "data: {...}" 或 "data: [DONE]"
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }

    LOG(`[SummaryAPI] 总结完成，共 ${fullText.length} 字`);
    onDone(fullText);
  },
};

// ════════════════════════════════════════════════════════
//  Offscreen 文档管理
// ════════════════════════════════════════════════════════

/** 确保 offscreen 文档存在（已存在则复用） */
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    LOG("[Offscreen] 创建 offscreen 文档");
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_URL,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    });
    LOG("[Offscreen] offscreen 文档已创建");
  } else {
    LOG("[Offscreen] offscreen 文档已存在，复用");
  }
}

// ════════════════════════════════════════════════════════
//  全局任务状态
// ════════════════════════════════════════════════════════

/** @type {{ activeTabId:number|null, allWords:Array, chunksReceived:number, totalChunks:number, summaryPending:boolean }} */
let state = {
  activeTabId: null,
  allWords: [], // 所有 chunk 汇总的句子，按 start 升序
  chunksReceived: 0,
  totalChunks: TOTAL_CHUNKS,
  summaryPending: false, // true = ASR 完成后自动触发总结
};

/** 重置任务状态，绑定到新 tabId */
function resetState(tabId) {
  state = {
    activeTabId: tabId,
    allWords: [],
    chunksReceived: 0,
    totalChunks: TOTAL_CHUNKS,
    summaryPending: false,
  };
}

// ════════════════════════════════════════════════════════
//  字幕提取主流程
// ════════════════════════════════════════════════════════

/**
 * 启动 ASR 字幕提取
 * @param {string} bvid
 * @param {number} tabId
 * @param {string} [model='qwen3']
 */
async function startProcessing(bvid, tabId, model = "qwen3") {
  LOG(`==== startProcessing: bvid=${bvid} tabId=${tabId} model=${model} ====`);
  resetState(tabId);

  Msg.toTab(tabId, {
    type: "STATUS",
    status: "loading",
    message: "正在获取视频信息...",
  });

  try {
    const info = await BiliAPI.getVideoInfo(bvid);
    const audioUrl = await BiliAPI.getAudioStreamUrl(bvid, info.cid);

    Msg.toTab(tabId, {
      type: "STATUS",
      status: "processing",
      message: "下载并解码音频中...",
    });
    Msg.toPopup({ type: "PROCESSING_START", title: info.title });

    await ensureOffscreen();
    LOG("[BG] 发送 PROCESS_AUDIO 到 offscreen");
    chrome.runtime.sendMessage({
      _to: "offscreen",
      type: "PROCESS_AUDIO",
      audioUrl,
      model,
      totalChunks: TOTAL_CHUNKS,
    });
  } catch (err) {
    ERR(`startProcessing 失败: ${err.message}`);
    Msg.toTab(tabId, { type: "STATUS", status: "error", message: err.message });
    Msg.toPopup({ type: "ERROR", message: err.message });
  }
}

// ════════════════════════════════════════════════════════
//  视频总结主流程
// ════════════════════════════════════════════════════════

/**
 * 启动视频总结：
 *   有官方字幕 → 直接下载 → 调用 LLM 总结
 *   无官方字幕 → 先 ASR 转写 → ALL_DONE 后触发 LLM 总结
 * @param {string} bvid
 * @param {number} tabId
 * @param {string} [model='qwen3']
 */
async function startSummarize(bvid, tabId, model = "qwen3") {
  LOG(`==== startSummarize: bvid=${bvid} tabId=${tabId} model=${model} ====`);
  resetState(tabId);

  Msg.toPopup({
    type: "SUMMARY_STATUS",
    status: "loading",
    message: "正在检查视频字幕...",
  });

  try {
    const info = await BiliAPI.getVideoInfo(bvid);
    Msg.toPopup({
      type: "SUMMARY_STATUS",
      status: "loading",
      message: `「${info.title}」`,
    });

    // ── 尝试获取官方字幕 ─────────────────────────────────────
    const subtitleList = await BiliAPI.getSubtitleList(bvid, info.cid);

    if (subtitleList.length > 0) {
      // 优先中文字幕，其次取第一个
      const target =
        subtitleList.find((s) => s.lan.startsWith("zh")) ?? subtitleList[0];
      LOG(`[Summary] 发现官方字幕: ${target.lan_doc} (${target.lan})`);
      Msg.toPopup({
        type: "SUMMARY_STATUS",
        status: "loading",
        message: `使用官方字幕（${target.lan_doc}）下载中...`,
      });

      const subtitleText = await BiliAPI.downloadSubtitleText(
        target.subtitle_url,
      );
      LOG(`[Summary] 字幕文本就绪，${subtitleText.length} 字符，开始总结`);
      await runSummary(subtitleText, tabId);
    } else {
      // ── 无官方字幕：启动 ASR，ALL_DONE 后再总结 ─────────────
      LOG("[Summary] 无官方字幕，启动 ASR 转写...");
      Msg.toPopup({
        type: "SUMMARY_STATUS",
        status: "asr",
        message: "无官方字幕，AI 转写中（完成后自动总结）...",
      });

      state.summaryPending = true; // 标记：ALL_DONE 后执行总结
      const audioUrl = await BiliAPI.getAudioStreamUrl(bvid, info.cid);
      await ensureOffscreen();
      LOG("[BG] 发送 PROCESS_AUDIO 到 offscreen（总结模式）");
      chrome.runtime.sendMessage({
        _to: "offscreen",
        type: "PROCESS_AUDIO",
        audioUrl,
        model,
        totalChunks: TOTAL_CHUNKS,
      });
      // 后续由 ALL_DONE 消息触发 runSummary
    }
  } catch (err) {
    ERR(`startSummarize 失败: ${err.message}`);
    Msg.toPopup({ type: "SUMMARY_ERROR", message: err.message });
  }
}

/**
 * 执行 LLM 总结并将结果流式推送到 popup
 * @param {string} text   - 字幕/转写文本
 * @param {number} tabId
 */
async function runSummary(text, tabId) {
  LOG(`[Summary] 开始总结，文本长度: ${text.length} 字符`);
  Msg.toPopup({
    type: "SUMMARY_STATUS",
    status: "summarizing",
    message: "AI 总结中...",
  });

  try {
    await SummaryAPI.summarize(
      text,
      (delta) => Msg.toPopup({ type: "SUMMARY_CHUNK", delta }),
      (full) => {
        LOG(`[Summary] 总结完成，共 ${full.length} 字`);
        Msg.toPopup({ type: "SUMMARY_DONE", text: full });
        if (tabId) {
          Msg.toTab(tabId, {
            type: "STATUS",
            status: "ready",
            message: "视频总结已生成 ✅",
          });
        }
      },
    );
  } catch (err) {
    ERR(`runSummary 失败: ${err.message}`);
    Msg.toPopup({ type: "SUMMARY_ERROR", message: err.message });
  }
}

// ════════════════════════════════════════════════════════
//  消息路由
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 不属于 background 的消息，忽略
  if (msg._to && msg._to !== "background") return;

  LOG(`[MSG] type=${msg.type} from=${sender.url?.slice(0, 60) ?? "unknown"}`);

  // ── popup → START（字幕提取）─────────────────────────────
  if (msg.type === "START") {
    startProcessing(msg.bvid, msg.tabId, msg.model ?? "qwen3");
    sendResponse({ ok: true });
    return true;
  }

  // ── popup → SUMMARIZE（视频总结）──────────────────────────
  if (msg.type === "SUMMARIZE") {
    startSummarize(msg.bvid, msg.tabId, msg.model ?? "qwen3");
    sendResponse({ ok: true });
    return true;
  }

  // ── offscreen → CHUNK_DONE ────────────────────────────────
  if (msg.type === "CHUNK_DONE") {
    const { chunk_id, sentences } = msg;
    LOG(`[CHUNK_DONE] chunk_id=${chunk_id} | ${sentences.length} 句`);

    state.allWords.push(...sentences);
    state.allWords.sort((a, b) => a.start - b.start);
    state.chunksReceived++;

    const progress = Math.round(
      (state.chunksReceived / state.totalChunks) * 100,
    );

    if (state.summaryPending) {
      // 总结模式：只上报进度，不推送字幕到 content.js
      Msg.toPopup({
        type: "SUMMARY_PROGRESS",
        progress,
        message: `转写中 ${progress}%（${state.allWords.length} 句）`,
      });
    } else {
      // 普通字幕模式：推送字幕到页面
      if (state.activeTabId) {
        Msg.toTab(state.activeTabId, {
          type: "WORDS_UPDATE",
          sentences: state.allWords,
          chunk_id,
          progress,
        });
      }
      Msg.toPopup({
        type: "PROGRESS",
        progress,
        wordsCount: state.allWords.length,
      });
    }
    return true;
  }

  // ── offscreen → CHUNKS_TOTAL（动态扩容通知）──────────────
  if (msg.type === "CHUNKS_TOTAL") {
    LOG(`[CHUNKS_TOTAL] 总块数更新: ${state.totalChunks} → ${msg.total}`);
    state.totalChunks = msg.total;
    return true;
  }

  // ── offscreen → ALL_DONE ──────────────────────────────────
  if (msg.type === "ALL_DONE") {
    LOG(
      `[ALL_DONE] 共 ${state.allWords.length} 句 | summaryPending=${state.summaryPending}`,
    );

    if (state.summaryPending) {
      // ASR 完成 → 转入总结流程
      state.summaryPending = false;
      const text = state.allWords.map((s) => s.text).join("\n");
      LOG(`[ALL_DONE→Summary] 转写文本 ${text.length} 字符，开始总结`);
      runSummary(text, state.activeTabId);
    } else {
      // 普通字幕模式
      if (state.activeTabId) {
        Msg.toTab(state.activeTabId, {
          type: "ALL_DONE",
          sentences: state.allWords,
        });
      }
      Msg.toPopup({ type: "ALL_DONE", wordsCount: state.allWords.length });
    }
    return true;
  }

  // ── offscreen → WS_STATUS ─────────────────────────────────
  if (msg.type === "WS_STATUS") {
    LOG(`[WS_STATUS] connected=${msg.connected}`);
    Msg.toPopup(msg);
    return true;
  }

  // ── any → ERROR ───────────────────────────────────────────
  if (msg.type === "ERROR") {
    ERR(`[ERROR] ${msg.message}`);
    if (state.activeTabId) {
      Msg.toTab(state.activeTabId, {
        type: "STATUS",
        status: "error",
        message: msg.message,
      });
    }
    // 总结模式和字幕模式使用不同的错误类型，便于 popup 区分展示
    const errType = state.summaryPending ? "SUMMARY_ERROR" : "ERROR";
    Msg.toPopup({ type: errType, message: msg.message });
    return true;
  }
});

LOG("Background service worker 已启动");
