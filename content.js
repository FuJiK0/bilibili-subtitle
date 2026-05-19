// content.js — B站视频页面字幕覆盖层
// 后端直接返回句级时间戳（text/start/end），前端只负责渲染，不做任何分句逻辑。

const LOG = (...a) => console.log("[BiliSub Content]", ...a);

const LIST_UI = {
  sideWidth: 320,
  sideGap: 16,
  normalMaxHeight: 360,
  normalViewportRatio: 0.34,
  sideViewportRatio: 0.62,
  floatingViewportRatio: 0.52,
  floatingMinHeight: 220,
  dragEdgePadding: 8,
  dragStartThreshold: 4,
};

let cues = []; // [{text, start, end}]  直接来自后端
let container = null;
let textEl = null;
let listContainer = null; // 字幕列表容器
let rafId = null;
let isActive = false;
let lastCueText = "";
let toastEl = null;

let fontSize = 19;
let bgOpacity = 0.72;
let adjustLayoutHandler = null; // 统一保存布局回调，便于事件解绑
let listDragState = null; // 记录字幕列表拖动中的指针偏移与 pointerId
let userListPosition = null; // 用户拖动后的固定位置：{left, top}

// ════════════════════════════════════════════════════════
//  DOM
// ════════════════════════════════════════════════════════

function findPlayerRoot() {
  return (
    document.querySelector(".bpx-player-video-wrap") ||
    document.querySelector(".bilibili-player-video") ||
    document.querySelector("#bilibili-player") ||
    document.querySelector("video")?.closest('[class*="player"]') ||
    document.querySelector("video")?.parentElement
  );
}

function createOverlay() {
  if (container) return;
  const root = findPlayerRoot();
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
  applyStyle();
  LOG("[DOM] 字幕层已挂载:", root.className || root.id);
}

function applyStyle() {
  if (!textEl) return;
  textEl.style.fontSize = `${fontSize}px`;
  textEl.style.background = `rgba(0,0,0,${bgOpacity})`;
}

// ════════════════════════════════════════════════════════
//  列表 DOM
// ════════════════════════════════════════════════════════

function findDanmakuBox() {
  return (
    document.querySelector("#danmaku-box") ||
    document.querySelector(".bpx-player-danmaku-wrap") ||
    document.querySelector(".bpx-player-danmaku") ||
    document.querySelector(".danmaku-box")
  );
}

function findCommentBox() {
  return (
    document.querySelector("#reply") ||
    document.querySelector(".bb-comment") ||
    document.querySelector(".comment-container") ||
    document.querySelector('[class*="comment"]')
  );
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

let isUserScrolling = false;
let scrollTimeout = null;

function markListInteracting() {
  isUserScrolling = true;
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => (isUserScrolling = false), 3000);
}

function getListContentNode() {
  return listContainer?.querySelector("#bilisub-list-content") ?? null;
}

function setListHeight(mode) {
  if (!listContainer) return;

  const playerRect =
    document.querySelector(".bpx-player-video-wrap")?.getBoundingClientRect() ||
    document.querySelector(".bilibili-player-video")?.getBoundingClientRect();

  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const playerHeight = playerRect?.height ?? 0;

  let maxHeight = LIST_UI.normalMaxHeight;
  if (mode === "wide") {
    maxHeight = Math.max(
      LIST_UI.normalMaxHeight,
      Math.min(
        viewportHeight * LIST_UI.sideViewportRatio,
        playerHeight || Infinity,
      ),
    );
  } else if (mode === "floating") {
    maxHeight = Math.max(
      LIST_UI.floatingMinHeight,
      Math.min(
        viewportHeight * LIST_UI.floatingViewportRatio,
        playerHeight * 0.72 || Infinity,
      ),
    );
  } else {
    maxHeight = Math.max(
      240,
      Math.min(
        viewportHeight * LIST_UI.normalViewportRatio,
        LIST_UI.normalMaxHeight,
      ),
    );
  }

  listContainer.style.setProperty(
    "--bilisub-list-max-height",
    `${Math.round(maxHeight)}px`,
  );
}

function clampListPosition(left, top) {
  if (!listContainer) return { left, top };

  const rect = listContainer.getBoundingClientRect();
  const padding = LIST_UI.dragEdgePadding;
  const viewportWidth =
    window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const maxLeft = Math.max(padding, viewportWidth - rect.width - padding);
  const maxTop = Math.max(padding, viewportHeight - rect.height - padding);

  return {
    left: Math.min(Math.max(left, padding), maxLeft),
    top: Math.min(Math.max(top, padding), maxTop),
  };
}

function applyListUserPosition() {
  if (!listContainer || !userListPosition) return;

  const next = clampListPosition(userListPosition.left, userListPosition.top);
  userListPosition = next;
  listContainer.style.left = `${Math.round(next.left)}px`;
  listContainer.style.top = `${Math.round(next.top)}px`;
  listContainer.style.right = "auto";
  listContainer.style.bottom = "auto";
}

function switchListToUserPositioned() {
  if (!listContainer) return;

  if (
    !listContainer.isConnected ||
    listContainer.parentElement !== document.body
  ) {
    document.body.appendChild(listContainer);
  }

  listContainer.style.flex = "";
  listContainer.classList.add("fixed-fallback", "user-positioned");
  listContainer.classList.remove(
    "floating-mode",
    "sidebar-mode",
    "inline-mode",
  );
  setListHeight("floating");
  applyListUserPosition();
}

function moveListContainer(targetParent, insertBefore = null) {
  if (!listContainer || !targetParent) return false;
  if (
    listContainer.parentElement === targetParent &&
    (!insertBefore || listContainer.nextSibling === insertBefore)
  ) {
    return false;
  }

  targetParent.insertBefore(listContainer, insertBefore);
  return true;
}

function applyListContainerLayout() {
  if (!listContainer) return;

  const pc = document.querySelector(".bpx-player-container");
  const isWebFsOrFull =
    (pc && pc.classList.contains("bpx-state-web-fs")) ||
    document.fullscreenElement !== null;
  const isWideScreen = pc && pc.getAttribute("data-screen") === "wide";

  if (userListPosition) {
    switchListToUserPositioned();
    if (isWebFsOrFull) listContainer.classList.add("fullscreen-mode");
    else listContainer.classList.remove("fullscreen-mode");
    return;
  }

  if (isWebFsOrFull) {
    if (
      !listContainer.isConnected ||
      listContainer.parentElement !== document.body
    ) {
      document.body.appendChild(listContainer);
    }
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
    const replyBox = findCommentBox();
    if (replyBox && replyBox.parentElement && isElementVisible(replyBox)) {
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
  ) {
    document.body.appendChild(listContainer);
  }
  listContainer.classList.add("fixed-fallback");
  listContainer.classList.remove(
    "floating-mode",
    "sidebar-mode",
    "inline-mode",
    "fullscreen-mode",
  );
  setListHeight("floating");
}

function bindListDrag(header) {
  if (!listContainer || header.hasAttribute("data-drag-bound")) return;

  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("#bilisub-list-toggle")) return;

    const rect = listContainer.getBoundingClientRect();
    listDragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      active: false,
    };

    header.setPointerCapture?.(e.pointerId);
  });

  header.addEventListener("pointermove", (e) => {
    if (!listDragState || e.pointerId !== listDragState.pointerId) return;

    if (!listDragState.active) {
      const moved = Math.hypot(
        e.clientX - listDragState.startX,
        e.clientY - listDragState.startY,
      );
      if (moved < LIST_UI.dragStartThreshold) return;

      listDragState.active = true;
      userListPosition = {
        left: listDragState.rectLeft,
        top: listDragState.rectTop,
      };
      switchListToUserPositioned();
      listContainer.classList.add("dragging");
    }

    userListPosition = clampListPosition(
      e.clientX - listDragState.offsetX,
      e.clientY - listDragState.offsetY,
    );
    applyListUserPosition();
    e.preventDefault();
  });

  const stopDragging = (e) => {
    if (!listDragState || e.pointerId !== listDragState.pointerId) return;
    listDragState = null;
    listContainer?.classList.remove("dragging");
    header.releasePointerCapture?.(e.pointerId);
  };

  header.addEventListener("pointerup", stopDragging);
  header.addEventListener("pointercancel", stopDragging);
  header.setAttribute("data-drag-bound", "true");
}

function updateSubtitleList() {
  if (!listContainer) initSubtitleListContainer();
  const contentNode = getListContentNode();
  if (!contentNode) return;

  if (!contentNode.hasAttribute("data-scroll-bound")) {
    // 这里只做滚动状态标记，不阻止默认行为，使用 passive 监听避免滚动性能警告。
    contentNode.addEventListener("wheel", markListInteracting, {
      passive: true,
    });
    contentNode.addEventListener("touchstart", markListInteracting, {
      passive: true,
    });
    contentNode.setAttribute("data-scroll-bound", "true");
  }

  const currentCount = contentNode.children.length;
  if (currentCount > cues.length) {
    contentNode.innerHTML = "";
  }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    let item = contentNode.children[i];

    if (!item) {
      item = document.createElement("div");
      item.className = "bilisub-list-item";

      const timeButton = document.createElement("button");
      timeButton.className = "bilisub-list-item-time";
      timeButton.type = "button";

      const textSpan = document.createElement("span");
      textSpan.className = "bilisub-list-item-text";

      item.appendChild(timeButton);
      item.appendChild(textSpan);

      contentNode.appendChild(item);
    }

    item.dataset.start = cue.start;
    if (!item.hasAttribute("data-click-bound")) {
      const jumpHandler = function (e) {
        e.preventDefault();
        e.stopPropagation();
        const t = parseFloat(this.dataset.start);
        LOG("[List] 点击跳转到:", t);
        if (!isNaN(t)) jumpToTime(t);
      };
      item.addEventListener("click", jumpHandler);
      item.children[0].addEventListener("click", jumpHandler.bind(item));
      item.setAttribute("data-click-bound", "true");
    }

    const timeStr = formatTime(cue.start);
    if (item.children[0].textContent !== timeStr) {
      item.children[0].textContent = timeStr;
    }
    if (item.children[1].textContent !== cue.text) {
      item.children[1].textContent = cue.text;
    }
    item.title = `${timeStr} ${cue.text}`;
  }

  while (contentNode.children.length > cues.length) {
    contentNode.removeChild(contentNode.lastChild);
  }

  if (contentNode._lastSubCount !== cues.length) {
    if (!isUserScrolling) {
      contentNode.scrollTop = contentNode.scrollHeight;
    }
    contentNode._lastSubCount = cues.length;
  }
}

let layoutObserver = null;

function startLayoutObserver() {
  if (layoutObserver) return;

  const playerContainer = document.querySelector(".bpx-player-container");
  if (!playerContainer) {
    // 播放器容器尚未加载，稍后重试（可通过 MutationObserver 监听 body 直到出现）
    return;
  }

  // 定义调整布局的函数
  adjustLayoutHandler = () => {
    applyListContainerLayout();
    updateSubtitleList();
  };

  // 创建 MutationObserver 监听播放器容器的属性变化
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
        // 检查是否有评论区节点被添加或移除
        const hasReplyChange =
          Array.from(mut.addedNodes).some(
            (n) =>
              n.nodeType === 1 &&
              (n.matches?.("#reply, .bb-comment") ||
                n.querySelector?.("#reply, .bb-comment")),
          ) ||
          Array.from(mut.removedNodes).some(
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

  // 观察播放器容器
  layoutObserver.observe(playerContainer, {
    attributes: true,
    attributeFilter: ["class", "data-screen"],
    childList: true,
    subtree: true, // 监听子节点变化以捕获评论区
  });

  // 同时监听全屏变化事件（document.fullscreenElement 不会触发 MutationObserver）
  document.addEventListener("fullscreenchange", adjustLayoutHandler);
  document.addEventListener("webkitfullscreenchange", adjustLayoutHandler);
  window.addEventListener("resize", adjustLayoutHandler);

  // 立即执行一次初始布局
  adjustLayoutHandler();
}

function removeOverlay() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (container) {
    container.remove();
    container = null;
    textEl = null;
  }
  if (listContainer) {
    listContainer.remove();
    listContainer = null;
  }
  listDragState = null;
  userListPosition = null;
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

function initSubtitleListContainer() {
  // 如果已存在且未被移除，直接返回
  if (listContainer && listContainer.isConnected) return;

  // ════════════════════════════════════════════════════════
  // 1. 创建 DOM 元素（容器、头部、内容区）
  // ════════════════════════════════════════════════════════
  listContainer = document.createElement("div");
  listContainer.id = "bilisub-list-container";
  listContainer.className = "collapsed";

  const header = document.createElement("div");
  header.id = "bilisub-list-header";
  header.innerHTML =
    '<span id="bilisub-list-title">字幕列表</span><button id="bilisub-list-toggle" type="button">展开</button>';
  listContainer.appendChild(header);
  bindListDrag(header);

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

  // 统一注入样式，避免散落的内联样式难以复用。
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
        background:
          linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,252,0.94));
        box-shadow:
          0 18px 40px rgba(15, 23, 42, 0.08),
          0 2px 10px rgba(15, 23, 42, 0.04);
        color: #0f172a;
        overflow: hidden;
        backdrop-filter: blur(14px);
      }

      #bilisub-list-container.sidebar-mode {
        margin: 0 0 0 ${LIST_UI.sideGap}px;
        width: ${LIST_UI.sideWidth}px;
      }

      #bilisub-list-container.inline-mode {
        width: 100%;
      }

      #bilisub-list-container.floating-mode,
      #bilisub-list-container.fixed-fallback {
        width: min(360px, calc(100vw - 32px));
        background: rgba(15, 23, 42, 0.88);
        border-color: rgba(255, 255, 255, 0.14);
        color: #e2e8f0;
        pointer-events: auto;
      }

      #bilisub-list-container.floating-mode {
        position: absolute;
        top: 20px;
        right: 20px;
        z-index: 9999;
      }

      #bilisub-list-container.fixed-fallback {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 9999;
      }

      #bilisub-list-container.fullscreen-mode {
        right: 20px;
        top: 20px;
        bottom: auto;
        width: min(380px, calc(100vw - 40px));
        z-index: 2147483646;
      }

      #bilisub-list-container.user-positioned {
        position: fixed;
        margin: 0;
        width: min(380px, calc(100vw - 16px));
        z-index: 2147483646;
      }

      #bilisub-list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        background: linear-gradient(90deg, rgba(248,250,252,0.9), rgba(241,245,249,0.72));
        cursor: grab;
        user-select: none;
        touch-action: none;
      }

      #bilisub-list-container.dragging #bilisub-list-header {
        cursor: grabbing;
      }

      #bilisub-list-container.floating-mode #bilisub-list-header,
      #bilisub-list-container.fixed-fallback #bilisub-list-header {
        background: rgba(15, 23, 42, 0.24);
        border-bottom-color: rgba(255, 255, 255, 0.12);
      }

      #bilisub-list-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.04em;
      }

      #bilisub-list-toggle {
        border: 0;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        color: #0f172a;
        background: rgba(15, 23, 42, 0.08);
      }

      #bilisub-list-container.floating-mode #bilisub-list-toggle,
      #bilisub-list-container.fixed-fallback #bilisub-list-toggle {
        color: #e2e8f0;
        background: rgba(255, 255, 255, 0.12);
      }

      #bilisub-list-content {
        max-height: var(--bilisub-list-max-height);
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 8px;
      }

      #bilisub-list-container.collapsed #bilisub-list-content {
        display: none;
      }

      .bilisub-list-item {
        display: grid;
        grid-template-columns: 70px minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        width: 100%;
        margin-bottom: 8px;
        padding: 10px 12px;
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        transition: background 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
      }

      .bilisub-list-item:hover {
        background: rgba(15, 23, 42, 0.06);
        transform: translateY(-1px);
      }

      #bilisub-list-container.floating-mode .bilisub-list-item:hover,
      #bilisub-list-container.fixed-fallback .bilisub-list-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }

      .bilisub-list-item.active {
        background: rgba(14, 116, 144, 0.12);
        box-shadow: inset 0 0 0 1px rgba(14, 116, 144, 0.24);
      }

      #bilisub-list-container.floating-mode .bilisub-list-item.active,
      #bilisub-list-container.fixed-fallback .bilisub-list-item.active {
        background: rgba(56, 189, 248, 0.18);
        box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.26);
      }

      .bilisub-list-item-time {
        justify-self: start;
        min-width: 60px;
        border: 0;
        border-radius: 999px;
        padding: 6px 10px;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        color: #0369a1;
        background: rgba(14, 165, 233, 0.12);
        cursor: pointer;
      }

      #bilisub-list-container.floating-mode .bilisub-list-item-time,
      #bilisub-list-container.fixed-fallback .bilisub-list-item-time {
        color: #e0f2fe;
        background: rgba(14, 165, 233, 0.18);
      }

      .bilisub-list-item-text {
        min-width: 0;
        line-height: 1.6;
        font-size: 13px;
        color: inherit;
        word-break: break-word;
      }

      #bilisub-list-content::-webkit-scrollbar {
        width: 8px;
      }

      #bilisub-list-content::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: rgba(100, 116, 139, 0.38);
      }
    `;
    document.head.appendChild(style);
  }

  applyListContainerLayout();

  if (document.querySelector(".bpx-player-container")) {
    startLayoutObserver();
  } else {
    const bodyObserver = new MutationObserver(() => {
      if (document.querySelector(".bpx-player-container")) {
        bodyObserver.disconnect();
        startLayoutObserver();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  updateSubtitleList();
}

function formatTime(secs) {
  if (!secs || isNaN(secs)) return "00:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function jumpToTime(start) {
  LOG(`[DOM] jumpToTime: ${start}`);
  const root =
    document.querySelector(".bpx-player-video-wrap") ||
    document.querySelector(".bilibili-player-video") ||
    document.querySelector("#bilibili-player");
  const v = root
    ? root.querySelector("video, bwp-video")
    : document.querySelector("bwp-video") || document.querySelector("video");
  if (v) {
    v.currentTime = start;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    LOG("[DOM] Video not found for seek!");
  }
}

function highlightListItem(activeCue) {
  if (!listContainer) return;
  const contentNode = getListContentNode();
  if (!contentNode) return;
  const index = cues.findIndex((c) => c === activeCue);
  if (index === -1) return;

  const currentActive = contentNode.querySelector(".bilisub-list-item.active");
  if (currentActive) currentActive.classList.remove("active");

  const newActive = contentNode.children[index];
  if (newActive) {
    newActive.classList.add("active");
    if (!isUserScrolling) {
      const topPos = newActive.offsetTop;
      contentNode.scrollTop =
        topPos - contentNode.clientHeight / 2 + newActive.clientHeight / 2;
    }
  }
}

// ════════════════════════════════════════════════════════
//  rAF 渲染循环（YouTube 风格）
// ════════════════════════════════════════════════════════

function startLoop() {
  if (rafId) return;
  LOG("[Loop] 启动");

  const tick = () => {
    if (!isActive) {
      rafId = null;
      return;
    }

    const video = document.querySelector("video");
    if (video && textEl) {
      const t = video.currentTime;

      let active = cues.find((c) => t >= c.start && t <= c.end);

      // Holdover：句间空隙 < 0.5s 时桥接上/下句，避免闪烁
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
          const idx = cues.indexOf(active);
          const prev = cues[idx - 1];
          const next = cues[idx + 1];
          LOG(
            `[Cue►] t=${t.toFixed(2)}s | [${active.start.toFixed(2)}-${active.end.toFixed(2)}s] 「${active.text}」` +
              (prev
                ? ` | 前句间隔=${(active.start - prev.end).toFixed(2)}s`
                : "") +
              (next
                ? ` | 后句间隔=${(next.start - active.end).toFixed(2)}s`
                : ""),
          );
          highlightListItem(active);
        }
      } else if (lastCueText !== "") {
        container.classList.remove("visible");
        LOG(
          `[Cue◄] 隐藏 @ t=${t.toFixed(2)}s | 最近结束句结束于 ` +
            `${
              [...cues]
                .reverse()
                .find((c) => c.end <= t)
                ?.end?.toFixed(2) ?? "?"
            }s`,
        );
        lastCueText = "";
        if (listContainer) {
          const currentActive = listContainer.querySelector(
            ".bilisub-list-item.active",
          );
          if (currentActive) currentActive.classList.remove("active");
        }
      }
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// ════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════

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
    const e = { loading: "⏳", processing: "⚙️", error: "❌", ready: "✅" };
    showToast(
      `${e[msg.status] ?? "📢"} ${msg.message}`,
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
      LOG(`[MSG] 首句: 「${cues[0].text}」[${cues[0].start}-${cues[0].end}s]`);
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
    applyStyle();
    return;
  }
});

LOG("content.js 已加载");
