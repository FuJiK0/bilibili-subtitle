// content.js — B站视频页面字幕覆盖层
// 后端直接返回句级时间戳（text/start/end），前端只负责渲染，不做分句逻辑。

const LOG = (...a) => console.log("[BiliSub Content]", ...a);

// ════════════════════════════════════════════════════════
//  列表 UI 布局常量
// ════════════════════════════════════════════════════════
const LIST_UI = {
  sideWidth: 320,
  sideGap: 16,
  normalMaxHeight: 360,
  normalViewportRatio: 0.34,
  sideViewportRatio: 0.62,
  floatingViewportRatio: 0.52,
  floatingMinHeight: 220,
};

// ════════════════════════════════════════════════════════
//  B站 DOM 查询模块
//  集中管理播放器、弹幕等容器的选择器，方便跨版本维护
// ════════════════════════════════════════════════════════
const BiliDOM = {
  /** 查找视频播放器根容器 */
  playerRoot() {
    return (
      document.querySelector(".bpx-player-video-wrap") ||
      document.querySelector(".bilibili-player-video") ||
      document.querySelector("#bilibili-player") ||
      document.querySelector("video")?.closest('[class*="player"]') ||
      document.querySelector("video")?.parentElement
    );
  },

  /** 查找弹幕容器 */
  danmakuBox() {
    return (
      document.querySelector("#danmaku-box") ||
      document.querySelector(".bpx-player-danmaku-wrap") ||
      document.querySelector(".bpx-player-danmaku") ||
      document.querySelector(".danmaku-box")
    );
  },

  /** 查找评论区容器 */
  commentBox() {
    return (
      document.querySelector("#reply") ||
      document.querySelector(".bb-comment") ||
      document.querySelector(".comment-container") ||
      document.querySelector('[class*="comment"]')
    );
  },

  /** 查找页面内 <video> 元素 */
  video() {
    const root = this.playerRoot();
    return root
      ? root.querySelector("video, bwp-video")
      : document.querySelector("bwp-video") || document.querySelector("video");
  },
};

// ════════════════════════════════════════════════════════
//  时间工具
// ════════════════════════════════════════════════════════

/**
 * 秒数格式化为 MM:SS
 * @param {number} secs
 * @returns {string}
 */
function formatTime(secs) {
  if (!secs || isNaN(secs)) return "00:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * 跳转视频到指定时间并播放
 * @param {number} start - 目标秒数
 */
function jumpToTime(start) {
  LOG(`[DOM] jumpToTime: ${start}s`);
  const v = BiliDOM.video();
  if (!v) {
    LOG("[DOM] 未找到 video 元素");
    return;
  }
  v.currentTime = start;
  const p = v.play();
  if (p?.catch) p.catch(() => {});
}

// ════════════════════════════════════════════════════════
//  字幕覆盖层（视频中央底部浮层）
// ════════════════════════════════════════════════════════

/** @type {HTMLElement|null} 字幕容器 */
let container = null;
/** @type {HTMLElement|null} 字幕文本节点 */
let textEl = null;

/** 创建字幕覆盖层 DOM，挂载到播放器容器 */
function createOverlay() {
  if (container) return;
  const root = BiliDOM.playerRoot();
  if (!root) {
    LOG("[DOM] 未找到播放器容器");
    return;
  }
  if (getComputedStyle(root).position === "static")
    root.style.position = "relative";

  container = document.createElement("div");
  container.id = "bilisub-container";
  container.innerHTML = '<span id="bilisub-text"></span>';
  root.appendChild(container);
  textEl = container.querySelector("#bilisub-text");
  applyOverlayStyle();
  LOG("[DOM] 字幕层已挂载:", root.className || root.id);
}

/** 将当前 fontSize/bgOpacity 应用到字幕文字节点 */
function applyOverlayStyle() {
  if (!textEl) return;
  textEl.style.fontSize = `${fontSize}px`;
  textEl.style.background = `rgba(0,0,0,${bgOpacity})`;
}

/** 移除字幕覆盖层及列表，停止 rAF */
function removeOverlay() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  container?.remove();
  container = null;
  textEl = null;
  listContainer?.remove();
  listContainer = null;
  isActive = false;
  lastCueText = "";
  LOG("[DOM] 字幕层已移除");

  if (layoutObserver) {
    layoutObserver.disconnect();
    layoutObserver = null;
  }
  if (adjustLayoutHandler) {
    document.removeEventListener("fullscreenchange", adjustLayoutHandler);
    document.removeEventListener("webkitfullscreenchange", adjustLayoutHandler);
    window.removeEventListener("resize", adjustLayoutHandler);
    adjustLayoutHandler = null;
  }
}

// ════════════════════════════════════════════════════════
//  字幕数据 & 渲染状态
// ════════════════════════════════════════════════════════

/** @type {Array<{text:string, start:number, end:number}>} 当前所有字幕句子 */
let cues = [];
let isActive = false;
let lastCueText = ""; // 上一帧渲染的文本，用于 diff 优化

/** 用户当前是否正在手动滚动字幕列表 */
let isUserScrolling = false;
let scrollTimeout = null;

/** 标记用户在滚动，3s 后自动恢复自动滚动 */
function markListInteracting() {
  isUserScrolling = true;
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => (isUserScrolling = false), 3000);
}

// ════════════════════════════════════════════════════════
//  字幕列表（侧边/悬浮面板）
// ════════════════════════════════════════════════════════

/** @type {HTMLElement|null} 字幕列表容器 */
let listContainer = null;
/** @type {MutationObserver|null} 布局自适应观察器 */
let layoutObserver = null;
/** @type {Function|null} 布局刷新回调（事件解绑用） */
let adjustLayoutHandler = null;

/** 获取字幕列表内容节点 */
function getListContentNode() {
  return listContainer?.querySelector("#bilisub-list-content") ?? null;
}

/**
 * 根据播放器当前模式（宽屏/全屏/普通）更新列表高度
 * @param {'wide'|'floating'|'normal'} mode
 */
function setListHeight(mode) {
  if (!listContainer) return;
  const playerRect = BiliDOM.playerRoot()?.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const playerH = playerRect?.height ?? 0;
  let maxHeight;

  if (mode === "wide") {
    maxHeight = Math.max(
      LIST_UI.normalMaxHeight,
      Math.min(viewportH * LIST_UI.sideViewportRatio, playerH || Infinity),
    );
  } else if (mode === "floating") {
    maxHeight = Math.max(
      LIST_UI.floatingMinHeight,
      Math.min(
        viewportH * LIST_UI.floatingViewportRatio,
        playerH * 0.72 || Infinity,
      ),
    );
  } else {
    maxHeight = Math.max(
      240,
      Math.min(
        viewportH * LIST_UI.normalViewportRatio,
        LIST_UI.normalMaxHeight,
      ),
    );
  }

  listContainer.style.setProperty(
    "--bilisub-list-max-height",
    `${Math.round(maxHeight)}px`,
  );
}

/**
 * 将列表容器移入目标父元素（如位置无变化则跳过 DOM 操作）
 * @returns {boolean} 是否发生了 DOM 移动
 */
function moveListContainer(targetParent, insertBefore = null) {
  if (!listContainer || !targetParent) return false;
  if (
    listContainer.parentElement === targetParent &&
    (!insertBefore || listContainer.nextSibling === insertBefore)
  )
    return false;
  targetParent.insertBefore(listContainer, insertBefore);
  return true;
}

/** 根据页面当前布局状态自适应字幕列表位置和样式 */
function applyListContainerLayout() {
  if (!listContainer) return;

  const pc = document.querySelector(".bpx-player-container");
  const isWebFsOrFull =
    pc?.classList.contains("bpx-state-web-fs") ||
    document.fullscreenElement !== null;
  const isWideScreen = pc?.getAttribute("data-screen") === "wide";

  if (isWebFsOrFull) {
    if (
      !listContainer.isConnected ||
      listContainer.parentElement !== document.body
    )
      document.body.appendChild(listContainer);
    listContainer.classList.add("fixed-fallback", "fullscreen-mode");
    listContainer.classList.remove(
      "floating-mode",
      "sidebar-mode",
      "inline-mode",
    );
    setListHeight("floating");
    return;
  }

  if (isWideScreen) {
    const replyBox = BiliDOM.commentBox();
    const isVisible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    if (replyBox?.parentElement && isVisible(replyBox)) {
      const parent = replyBox.parentElement;
      parent.style.display = "flex";
      parent.style.alignItems = "flex-start";
      parent.style.flexWrap = "wrap";
      replyBox.style.flex = "1 1 0";
      listContainer.style.flex = `0 0 ${LIST_UI.sideWidth}px`;
      moveListContainer(parent, replyBox.nextSibling);
      listContainer.classList.add("sidebar-mode");
      listContainer.classList.remove(
        "floating-mode",
        "fixed-fallback",
        "inline-mode",
        "fullscreen-mode",
      );
      setListHeight("wide");
      return;
    }
  }

  if (
    !listContainer.isConnected ||
    listContainer.parentElement !== document.body
  )
    document.body.appendChild(listContainer);
  listContainer.classList.add("fixed-fallback");
  listContainer.classList.remove(
    "floating-mode",
    "sidebar-mode",
    "inline-mode",
    "fullscreen-mode",
  );
  setListHeight("floating");
}

/** 渲染/更新字幕列表 DOM（增量更新，避免整体重建） */
function updateSubtitleList() {
  if (!listContainer) initSubtitleListContainer();
  const contentNode = getListContentNode();
  if (!contentNode) return;

  // 绑定滚动状态标记（只绑一次）
  if (!contentNode.hasAttribute("data-scroll-bound")) {
    contentNode.addEventListener("wheel", markListInteracting, {
      passive: true,
    });
    contentNode.addEventListener("touchstart", markListInteracting, {
      passive: true,
    });
    contentNode.setAttribute("data-scroll-bound", "true");
  }

  // 如果数据减少（新任务），清空重建
  if (contentNode.children.length > cues.length) contentNode.innerHTML = "";

  // 增量更新已有行，追加新行
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let item = contentNode.children[i];

    if (!item) {
      item = document.createElement("div");
      item.className = "bilisub-list-item";
      item.appendChild(
        Object.assign(document.createElement("button"), {
          className: "bilisub-list-item-time",
          type: "button",
        }),
      );
      item.appendChild(
        Object.assign(document.createElement("span"), {
          className: "bilisub-list-item-text",
        }),
      );
      contentNode.appendChild(item);
    }

    // 跳转点击（只绑一次）
    item.dataset.start = cue.start;
    if (!item.hasAttribute("data-click-bound")) {
      const jumpHandler = function (e) {
        e.preventDefault();
        e.stopPropagation();
        const t = parseFloat(this.dataset.start);
        LOG("[List] 点击跳转:", t);
        if (!isNaN(t)) jumpToTime(t);
      };
      item.addEventListener("click", jumpHandler);
      item.children[0].addEventListener("click", jumpHandler.bind(item));
      item.setAttribute("data-click-bound", "true");
    }

    const timeStr = formatTime(cue.start);
    if (item.children[0].textContent !== timeStr)
      item.children[0].textContent = timeStr;
    if (item.children[1].textContent !== cue.text)
      item.children[1].textContent = cue.text;
    item.title = `${timeStr} ${cue.text}`;
  }

  // 删除多余行
  while (contentNode.children.length > cues.length)
    contentNode.removeChild(contentNode.lastChild);

  // 新句子追加后滚动到底部
  if (contentNode._lastSubCount !== cues.length) {
    if (!isUserScrolling) contentNode.scrollTop = contentNode.scrollHeight;
    contentNode._lastSubCount = cues.length;
  }
}

/**
 * 高亮当前播放句子对应的列表项，并滚动列表跟随
 * @param {{text:string, start:number, end:number}} activeCue
 */
function highlightListItem(activeCue) {
  if (!listContainer) return;
  const contentNode = getListContentNode();
  if (!contentNode) return;

  const index = cues.findIndex((c) => c === activeCue);
  if (index === -1) return;

  contentNode
    .querySelector(".bilisub-list-item.active")
    ?.classList.remove("active");
  const newActive = contentNode.children[index];
  if (newActive) {
    newActive.classList.add("active");
    if (!isUserScrolling) {
      contentNode.scrollTop =
        newActive.offsetTop -
        contentNode.clientHeight / 2 +
        newActive.clientHeight / 2;
    }
  }
}

/** 启动播放器布局变化监听器 */
function startLayoutObserver() {
  if (layoutObserver) return;
  const playerContainer = document.querySelector(".bpx-player-container");
  if (!playerContainer) return;

  adjustLayoutHandler = () => {
    applyListContainerLayout();
    updateSubtitleList();
  };

  layoutObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (
        mut.type === "attributes" &&
        (mut.attributeName === "class" || mut.attributeName === "data-screen")
      ) {
        adjustLayoutHandler();
        break;
      }
      if (mut.type === "childList") {
        const hasReplyChange = [...mut.addedNodes, ...mut.removedNodes].some(
          (n) =>
            n.nodeType === 1 &&
            (n.matches?.("#reply, .bb-comment") ||
              n.querySelector?.("#reply, .bb-comment")),
        );
        if (hasReplyChange) {
          adjustLayoutHandler();
          break;
        }
      }
    }
  });

  layoutObserver.observe(playerContainer, {
    attributes: true,
    attributeFilter: ["class", "data-screen"],
    childList: true,
    subtree: true,
  });

  document.addEventListener("fullscreenchange", adjustLayoutHandler);
  document.addEventListener("webkitfullscreenchange", adjustLayoutHandler);
  window.addEventListener("resize", adjustLayoutHandler);

  adjustLayoutHandler(); // 立即执行一次
}

/** 初始化字幕列表容器（首次调用时建 DOM 并注入样式） */
function initSubtitleListContainer() {
  if (listContainer?.isConnected) return;

  listContainer = document.createElement("div");
  listContainer.id = "bilisub-list-container";
  listContainer.className = "collapsed";

  // 头部（标题 + 展开/收起）
  const header = document.createElement("div");
  header.id = "bilisub-list-header";
  header.innerHTML =
    '<span id="bilisub-list-title">字幕列表</span>' +
    '<button id="bilisub-list-toggle" type="button">展开</button>';
  listContainer.appendChild(header);

  const content = document.createElement("div");
  content.id = "bilisub-list-content";
  listContainer.appendChild(content);

  header.querySelector("#bilisub-list-toggle").addEventListener("click", () => {
    listContainer.classList.toggle("collapsed");
    const isCol = listContainer.classList.contains("collapsed");
    header.querySelector("#bilisub-list-toggle").textContent = isCol
      ? "展开"
      : "隐藏";
  });

  // 样式注入（只注入一次）
  if (!document.getElementById("bilisub-list-style")) {
    const style = document.createElement("style");
    style.id = "bilisub-list-style";
    style.textContent = `
      #bilisub-list-container {
        --bilisub-list-max-height: 320px;
        box-sizing: border-box;
        width: 100%;
        margin: 16px 0;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 18px;
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.94));
        box-shadow: 0 18px 40px rgba(15,23,42,0.08), 0 2px 10px rgba(15,23,42,0.04);
        color: #0f172a;
        overflow: hidden;
        backdrop-filter: blur(14px);
      }
      #bilisub-list-container.sidebar-mode {
        margin: 0 0 0 ${LIST_UI.sideGap}px;
        width: ${LIST_UI.sideWidth}px;
      }
      #bilisub-list-container.floating-mode,
      #bilisub-list-container.fixed-fallback {
        width: min(360px, calc(100vw - 32px));
        background: rgba(15,23,42,0.88);
        border-color: rgba(255,255,255,0.14);
        color: #e2e8f0;
        pointer-events: auto;
      }
      #bilisub-list-container.floating-mode { position: absolute; top: 20px; right: 20px; z-index: 9999; }
      #bilisub-list-container.fixed-fallback { position: fixed; right: 16px; bottom: 16px; z-index: 9999; }
      #bilisub-list-container.fullscreen-mode {
        right: 20px; top: 20px; bottom: auto;
        width: min(380px, calc(100vw - 40px)); z-index: 2147483646;
      }
      #bilisub-list-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(148,163,184,0.18);
        background: linear-gradient(90deg, rgba(248,250,252,0.9), rgba(241,245,249,0.72));
      }
      #bilisub-list-container.floating-mode #bilisub-list-header,
      #bilisub-list-container.fixed-fallback #bilisub-list-header {
        background: rgba(15,23,42,0.24);
        border-bottom-color: rgba(255,255,255,0.12);
      }
      #bilisub-list-title { font-size: 14px; font-weight: 700; letter-spacing: 0.04em; }
      #bilisub-list-toggle {
        border: 0; border-radius: 999px; padding: 6px 12px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        color: #0f172a; background: rgba(15,23,42,0.08);
      }
      #bilisub-list-container.floating-mode #bilisub-list-toggle,
      #bilisub-list-container.fixed-fallback #bilisub-list-toggle {
        color: #e2e8f0; background: rgba(255,255,255,0.12);
      }
      #bilisub-list-content {
        max-height: var(--bilisub-list-max-height);
        overflow-y: auto; overscroll-behavior: contain; padding: 8px;
      }
      #bilisub-list-container.collapsed #bilisub-list-content { display: none; }
      .bilisub-list-item {
        display: grid; grid-template-columns: 70px minmax(0,1fr);
        gap: 12px; align-items: start;
        width: 100%; margin-bottom: 8px; padding: 10px 12px;
        border: 0; border-radius: 14px; cursor: pointer;
        transition: background 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
      }
      .bilisub-list-item:hover { background: rgba(15,23,42,0.06); transform: translateY(-1px); }
      #bilisub-list-container.floating-mode .bilisub-list-item:hover,
      #bilisub-list-container.fixed-fallback .bilisub-list-item:hover { background: rgba(255,255,255,0.08); }
      .bilisub-list-item.active { background: rgba(14,116,144,0.12); box-shadow: inset 0 0 0 1px rgba(14,116,144,0.24); }
      #bilisub-list-container.floating-mode .bilisub-list-item.active,
      #bilisub-list-container.fixed-fallback .bilisub-list-item.active {
        background: rgba(56,189,248,0.18); box-shadow: inset 0 0 0 1px rgba(125,211,252,0.26);
      }
      .bilisub-list-item-time {
        justify-self: start; min-width: 60px; border: 0; border-radius: 999px;
        padding: 6px 10px; font: inherit; font-size: 12px; font-weight: 700;
        color: #0369a1; background: rgba(14,165,233,0.12); cursor: pointer;
      }
      #bilisub-list-container.floating-mode .bilisub-list-item-time,
      #bilisub-list-container.fixed-fallback .bilisub-list-item-time {
        color: #e0f2fe; background: rgba(14,165,233,0.18);
      }
      .bilisub-list-item-text { min-width: 0; line-height: 1.6; font-size: 13px; color: inherit; word-break: break-word; }
      #bilisub-list-content::-webkit-scrollbar { width: 8px; }
      #bilisub-list-content::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(100,116,139,0.38); }
    `;
    document.head.appendChild(style);
  }

  applyListContainerLayout();

  // 等播放器容器就绪后启动布局观察器
  if (document.querySelector(".bpx-player-container")) {
    startLayoutObserver();
  } else {
    const bodyObs = new MutationObserver(() => {
      if (document.querySelector(".bpx-player-container")) {
        bodyObs.disconnect();
        startLayoutObserver();
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  updateSubtitleList();
}

// ════════════════════════════════════════════════════════
//  rAF 渲染循环（YouTube 风格）
// ════════════════════════════════════════════════════════

/** requestAnimationFrame 句柄 */
let rafId = null;

/** 样式参数（可由 popup 通过 SET_STYLE 消息动态修改） */
let fontSize = 19;
let bgOpacity = 0.72;

/** 启动每帧渲染循环 */
function startLoop() {
  if (rafId) return;
  LOG("[Loop] 启动");

  const tick = () => {
    if (!isActive) {
      rafId = null;
      return;
    }

    const video = BiliDOM.video();
    if (video && textEl) {
      const t = video.currentTime;
      // 找到当前时间命中的句子
      let active = cues.find((c) => t >= c.start && t <= c.end);

      // Holdover：句间空隙 < 0.5s 时桥接，避免字幕闪烁
      if (!active) {
        const LEAD = 0.5;
        const next = cues.find((c) => c.start > t);
        const prev = [...cues].reverse().find((c) => c.end <= t);
        if (next && next.start - t < LEAD) active = next;
        else if (prev && t - prev.end < LEAD) active = prev;
      }

      if (active) {
        if (active.text !== lastCueText) {
          textEl.textContent = active.text;
          lastCueText = active.text;
          container.classList.add("visible");

          // 调试日志：句间隔，帮助排查字幕重叠/空白问题
          const idx = cues.indexOf(active);
          const prev = cues[idx - 1];
          const next = cues[idx + 1];
          LOG(
            `[Cue►] ${t.toFixed(2)}s [${active.start.toFixed(2)}-${active.end.toFixed(2)}s]` +
              ` 「${active.text}」` +
              (prev ? ` 前间隔=${(active.start - prev.end).toFixed(2)}s` : "") +
              (next ? ` 后间隔=${(next.start - active.end).toFixed(2)}s` : ""),
          );
          highlightListItem(active);
        }
      } else if (lastCueText !== "") {
        container.classList.remove("visible");
        LOG(`[Cue◄] 隐藏 @ ${t.toFixed(2)}s`);
        lastCueText = "";
        listContainer
          ?.querySelector(".bilisub-list-item.active")
          ?.classList.remove("active");
      }
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ════════════════════════════════════════════════════════
//  Toast 通知
// ════════════════════════════════════════════════════════

/** @type {HTMLElement|null} */
let toastEl = null;

/**
 * 在页面右上角弹出一条短暂提示
 * @param {string} msg
 * @param {'info'|'error'|'success'} type
 */
function showToast(msg, type = "info") {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "bilisub-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = `bilisub-toast-${type}`;
  toastEl.style.opacity = "1";
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = "0";
  }, 3500);
  LOG(`[Toast] [${type}] ${msg}`);
}

// ════════════════════════════════════════════════════════
//  消息监听
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  LOG(`[MSG] type=${msg.type}`);

  if (msg.type === "STATUS") {
    const icon = { loading: "⏳", processing: "⚙️", error: "❌", ready: "✅" };
    showToast(
      `${icon[msg.status] ?? "📢"} ${msg.message}`,
      msg.status === "error" ? "error" : "info",
    );
    return;
  }

  if (msg.type === "WORDS_UPDATE") {
    cues = msg.sentences ?? msg.words ?? [];
    LOG(
      `[MSG] WORDS_UPDATE chunk=${msg.chunk_id} 进度=${msg.progress}% 句=${cues.length}`,
    );
    showToast(`字幕转写中... ${msg.progress}%（${cues.length} 句）`, "info");
    updateSubtitleList();
    if (!isActive) {
      isActive = true;
      createOverlay();
      startLoop();
    }
    return;
  }

  if (msg.type === "ALL_DONE") {
    cues = msg.sentences ?? msg.words ?? [];
    LOG(`[MSG] ALL_DONE 句=${cues.length}`);
    if (cues.length)
      LOG(`首句: 「${cues[0].text}」[${cues[0].start}-${cues[0].end}s]`);
    showToast(`✅ 字幕生成完毕（共 ${cues.length} 句）`, "success");
    updateSubtitleList();
    if (!isActive) {
      isActive = true;
      createOverlay();
      startLoop();
    }
    return;
  }

  if (msg.type === "STOP") {
    removeOverlay();
    cues = [];
    showToast("字幕已关闭", "info");
    return;
  }

  if (msg.type === "SET_STYLE") {
    if (msg.fontSize !== undefined) fontSize = msg.fontSize;
    if (msg.bgOpacity !== undefined) bgOpacity = msg.bgOpacity;
    applyOverlayStyle();
    return;
  }
});

LOG("content.js 已加载");
