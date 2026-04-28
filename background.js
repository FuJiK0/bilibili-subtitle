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
  /** 向指定 Tab 的 content.js 发送消息 */
  toTab: (tabId, msg) =>
    chrome.tabs
      .sendMessage(tabId, msg)
      .catch((e) => LOG("→tab err:", e.message)),

  /** 向 popup 广播消息（popup 未开启时静默失败） */
  toPopup: (msg) =>
    chrome.runtime.sendMessage({ _to: "popup", ...msg }).catch(() => {}),
};

// ════════════════════════════════════════════════════════
//  B站 API 模块
// ════════════════════════════════════════════════════════
const BiliAPI = {
  /** BV 号 → 视频元数据（cid / title / duration） */
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
    return data.data;
  },

  /** bvid + cid → 最高码率纯音频流 URL */
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
   * [P3 FIX] bvid + cid → 官方字幕列表
   *
   * 错误分级（不再一律静默降级为"无字幕"）：
   *   - 网络异常 / HTTP 4xx-5xx → throw，由调用方决定中止还是展示错误
   *   - B站业务 code !== 0     → ERR 记录后返回 []（可能是非鉴权类的已知无内容码）
   *   - data.subtitle 字段缺失  → LOG warn 后返回 []（接口结构变化的兜底）
   *
   * @returns {Promise<Array<{lan, lan_doc, subtitle_url}>>}
   */
  async getSubtitleList(bvid, cid) {
    LOG(`[BiliAPI] getSubtitleList: bvid=${bvid} cid=${cid}`);
    let res;
    try {
      res = await fetch(
        `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`,
        { credentials: "include" },
      );
    } catch (networkErr) {
      throw new Error(`字幕接口网络异常: ${networkErr.message}`);
    }

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "（请检查 B站登录状态）"
          : res.status === 429
            ? "（请求过于频繁，稍后重试）"
            : "";
      throw new Error(`字幕接口 HTTP ${res.status} ${hint}`.trim());
    }

    const data = await res.json();

    if (data.code !== 0) {
      // 业务错误码不等于"真的没字幕"，明确记录以便排查
      ERR(
        `[BiliAPI] 字幕API 业务错误 code=${data.code} msg="${data.message}"，返回空字幕列表`,
      );
      return [];
    }

    if (!data.data?.subtitle) {
      LOG(
        "[BiliAPI] data.data.subtitle 字段缺失，接口结构可能变更，返回空列表",
      );
      return [];
    }

    const subtitles = data.data.subtitle.subtitles ?? [];
    LOG(
      `[BiliAPI] 字幕数量: ${subtitles.length}`,
      subtitles.map((s) => s.lan_doc),
    );
    return subtitles;
  },

  /**
   * 下载 B站字幕 JSON → 纯文本（按行拼接）
   * 字幕 JSON 格式：{ body: [{from, to, content}] }
   */
  async downloadSubtitleText(subtitleUrl) {
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
// ════════════════════════════════════════════════════════
const SummaryAPI = {
  BASE_URL: "http://127.0.0.1:8000/v1",

  buildPrompt(subtitleText) {
    return `请根据以下视频字幕内容，用中文生成一份简洁的视频总结。要求：
1. 先用 1-2 句话概括视频主旨
2. 列出 3-5 个核心要点（用 • 符号开头）
3. 如有结论或建议，简要说明

字幕内容：
${subtitleText}`;
  },

  /**
   * [P1 FIX] 流式调用本地 LLM，使用行缓冲区解决 SSE 跨网络分片问题
   *
   * 问题：reader.read() 返回的每个 Uint8Array 是网络层的任意分片，
   *       一条 SSE "data: {...}" 行可能被拆成两段到达。
   *       旧代码直接 split('\n') 后 JSON.parse，前半段 parse 失败被吞，
   *       后半段缺少 "data: " 前缀也被跳过，导致随机丢字。
   *
   * 修复：维护 lineBuffer，只在遇到 \n 时才提交完整行处理；
   *       TextDecoder 以 { stream: true } 模式运行，保留多字节字符跨块状态；
   *       循环结束后 flush decoder 并处理最后一行残余。
   *
   * @param {string}   subtitleText
   * @param {function} onChunk  - (delta: string) => void
   * @param {function} onDone   - (fullText: string) => void
   */
  async summarize(subtitleText, onChunk, onDone) {
    const prompt = this.buildPrompt(subtitleText);
    LOG(`[SummaryAPI] 发起请求，prompt 长度: ${prompt.length} 字符`);

    const res = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "default",
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
    let lineBuffer = ""; // 保留跨分片的不完整行，等到 \n 才提交

    /** 解析并分发一条完整的 SSE 行 */
    const parseLine = (line) => {
      if (!line.startsWith("data: ")) return;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
      } catch (e) {
        ERR(
          "[SummaryAPI] SSE JSON 解析失败:",
          e.message,
          "原始行:",
          line.slice(0, 80),
        );
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // stream: true 让 decoder 保留多字节字符的跨 chunk 状态
      lineBuffer += decoder.decode(value, { stream: true });

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // 最后一段没有 \n，留给下次拼接
      for (const line of lines) parseLine(line.trimEnd());
    }

    // 流结束后 flush decoder 残留字节，并处理最后可能没有 \n 结尾的行
    lineBuffer += decoder.decode();
    if (lineBuffer) parseLine(lineBuffer.trimEnd());

    LOG(`[SummaryAPI] 总结完成，共 ${fullText.length} 字`);
    onDone(fullText);
  },
};

// ════════════════════════════════════════════════════════
//  Offscreen 文档管理
// ════════════════════════════════════════════════════════
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

/**
 * @type {{
 *   activeTabId:    number|null,
 *   sessionId:      number,        // [P2] 单调递增版本号，随 PROCESS_AUDIO 下发到 offscreen
 *   allWords:       Array,         // 所有 chunk 汇总的句子，按 start 升序
 *   chunksReceived: number,
 *   totalChunks:    number,
 *   summaryPending: boolean,       // true = ASR 完成后自动触发总结
 * }}
 */
let state = {
  activeTabId: null,
  sessionId: 0,
  allWords: [],
  chunksReceived: 0,
  totalChunks: TOTAL_CHUNKS,
  summaryPending: false,
};

/**
 * [P2 FIX] 重置任务状态并生成新 sessionId
 * sessionId 递增后，旧任务在 offscreen 的 WS 回包会因 sessionId 不匹配而被丢弃，
 * 防止串任务时旧结果污染新任务进度和 allWords。
 */
function resetState(tabId) {
  const newSessionId = state.sessionId + 1;
  state = {
    activeTabId: tabId,
    sessionId: newSessionId,
    allWords: [],
    chunksReceived: 0,
    totalChunks: TOTAL_CHUNKS,
    summaryPending: false,
  };
  LOG(`[State] 新任务 sessionId=${newSessionId} tabId=${tabId}`);
}

// ════════════════════════════════════════════════════════
//  字幕提取主流程
// ════════════════════════════════════════════════════════
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
    LOG(`[BG] 发送 PROCESS_AUDIO 到 offscreen sessionId=${state.sessionId}`);
    chrome.runtime.sendMessage({
      _to: "offscreen",
      type: "PROCESS_AUDIO",
      sessionId: state.sessionId, // [P2] 随任务下发，offscreen 回包时带回
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

    // [Fix 3] getSubtitleList 的网络/HTTP 异常不再向上抛出终止整个流程，
    // 而是捕获后记录警告，降级到 ASR 路径继续执行。
    // 只有 getVideoInfo / getAudioStreamUrl 等核心接口失败才会终止。
    let subtitleList = [];
    try {
      subtitleList = await BiliAPI.getSubtitleList(bvid, info.cid);
    } catch (subtitleErr) {
      ERR(`[Summary] 字幕接口异常，降级到 ASR 路径: ${subtitleErr.message}`);
      Msg.toPopup({
        type: "SUMMARY_STATUS",
        status: "asr",
        message: `字幕获取失败（${subtitleErr.message}），改用 AI 转写...`,
      });
      // subtitleList 保持 []，下方逻辑自然走 ASR 分支
    }

    if (subtitleList.length > 0) {
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
      LOG(`[Summary] 字幕文本就绪，${subtitleText.length} 字符`);
      await runSummary(subtitleText, tabId);
    } else {
      LOG("[Summary] 无官方字幕，启动 ASR 转写...");
      Msg.toPopup({
        type: "SUMMARY_STATUS",
        status: "asr",
        message: "无官方字幕，AI 转写中（完成后自动总结）...",
      });

      state.summaryPending = true;
      const audioUrl = await BiliAPI.getAudioStreamUrl(bvid, info.cid);
      await ensureOffscreen();
      LOG(
        `[BG] 发送 PROCESS_AUDIO 到 offscreen（总结模式）sessionId=${state.sessionId}`,
      );
      chrome.runtime.sendMessage({
        _to: "offscreen",
        type: "PROCESS_AUDIO",
        sessionId: state.sessionId, // [P2]
        audioUrl,
        model,
        totalChunks: TOTAL_CHUNKS,
      });
    }
  } catch (err) {
    ERR(`startSummarize 失败: ${err.message}`);
    Msg.toPopup({ type: "SUMMARY_ERROR", message: err.message });
  }
}

/**
 * 执行 LLM 总结并将结果流式推送到 popup
 * @param {string} text
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
        if (tabId)
          Msg.toTab(tabId, {
            type: "STATUS",
            status: "ready",
            message: "视频总结已生成 ✅",
          });
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
  if (msg._to && msg._to !== "background") return;

  LOG(`[MSG] type=${msg.type} from=${sender.url?.slice(0, 60) ?? "unknown"}`);

  // ── popup → START ─────────────────────────────────────
  if (msg.type === "START") {
    startProcessing(msg.bvid, msg.tabId, msg.model ?? "qwen3");
    sendResponse({ ok: true });
    return true;
  }

  // ── popup → SUMMARIZE ─────────────────────────────────
  if (msg.type === "SUMMARIZE") {
    startSummarize(msg.bvid, msg.tabId, msg.model ?? "qwen3");
    sendResponse({ ok: true });
    return true;
  }

  // ── offscreen → CHUNK_DONE ────────────────────────────
  if (msg.type === "CHUNK_DONE") {
    // [P2 FIX] 校验 sessionId，丢弃旧任务的晚到回包
    if (msg.sessionId !== state.sessionId) {
      LOG(
        `[CHUNK_DONE] 丢弃旧任务回包 sessionId=${msg.sessionId}（当前=${state.sessionId}）`,
      );
      return true;
    }

    const { chunk_id, sentences } = msg;
    LOG(`[CHUNK_DONE] chunk_id=${chunk_id} | ${sentences.length} 句`);

    state.allWords.push(...sentences);
    state.allWords.sort((a, b) => a.start - b.start);
    state.chunksReceived++;

    const progress = Math.round(
      (state.chunksReceived / state.totalChunks) * 100,
    );

    if (state.summaryPending) {
      Msg.toPopup({
        type: "SUMMARY_PROGRESS",
        progress,
        message: `转写中 ${progress}%（${state.allWords.length} 句）`,
      });
    } else {
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

  // ── offscreen → CHUNKS_TOTAL ──────────────────────────
  if (msg.type === "CHUNKS_TOTAL") {
    // [P2 FIX] 同样校验 sessionId
    if (msg.sessionId !== state.sessionId) {
      LOG(`[CHUNKS_TOTAL] 丢弃旧任务消息 sessionId=${msg.sessionId}`);
      return true;
    }
    LOG(`[CHUNKS_TOTAL] 总块数更新: ${state.totalChunks} → ${msg.total}`);
    state.totalChunks = msg.total;
    return true;
  }

  // ── offscreen → ALL_DONE ──────────────────────────────
  if (msg.type === "ALL_DONE") {
    // [P2 FIX] 同样校验 sessionId，防止旧任务提前触发 ALL_DONE 或总结
    if (msg.sessionId !== state.sessionId) {
      LOG(
        `[ALL_DONE] 丢弃旧任务回包 sessionId=${msg.sessionId}（当前=${state.sessionId}）`,
      );
      return true;
    }

    LOG(
      `[ALL_DONE] 共 ${state.allWords.length} 句 | summaryPending=${state.summaryPending}`,
    );

    if (state.summaryPending) {
      state.summaryPending = false;
      const text = state.allWords.map((s) => s.text).join("\n");
      LOG(`[ALL_DONE→Summary] 转写文本 ${text.length} 字符，开始总结`);
      runSummary(text, state.activeTabId);
    } else {
      if (state.activeTabId)
        Msg.toTab(state.activeTabId, {
          type: "ALL_DONE",
          sentences: state.allWords,
        });
      Msg.toPopup({ type: "ALL_DONE", wordsCount: state.allWords.length });
    }
    return true;
  }

  // ── offscreen → WS_STATUS ─────────────────────────────
  if (msg.type === "WS_STATUS") {
    LOG(`[WS_STATUS] connected=${msg.connected}`);
    Msg.toPopup(msg);
    return true;
  }

  // ── any → ERROR ───────────────────────────────────────
  if (msg.type === "ERROR") {
    ERR(`[ERROR] ${msg.message}`);
    if (state.activeTabId)
      Msg.toTab(state.activeTabId, {
        type: "STATUS",
        status: "error",
        message: msg.message,
      });
    const errType = state.summaryPending ? "SUMMARY_ERROR" : "ERROR";
    Msg.toPopup({ type: errType, message: msg.message });
    return true;
  }
});

LOG("Background service worker 已启动");
