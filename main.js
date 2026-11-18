// Codex 桌面端 token 用量状态栏 — 独立置顶 Electron 窗口
// 零改动 ChatGPT.app，只读 ~/.codex/sessions 数据
"use strict";
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS = path.join(CODEX_HOME, "sessions");
const SETTINGS_FILE = path.join(app.getPath("userData"), "statusbar-settings.json");

const DEFAULT_SETTINGS = {
  mode: "follow",           // follow = 贴 ChatGPT 右上角；free = 用户自由拖放
  x: null, y: null, width: 520, height: 30,
  show: { model: true, session: true, turn: true, ctx: true, tools: true, today: true, rate: true },
};
let savedSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(data);
    savedSettings = { ...savedSettings, ...parsed, show: { ...DEFAULT_SETTINGS.show, ...(parsed.show || {}) } };
  } catch (e) { /* use defaults */ }
}
function persistSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(savedSettings, null, 2)); } catch (e) { /* ignore */ }
}

// ───────────────────────── 会话文件发现 ─────────────────────────

function todayDir() {
  const now = new Date();
  return path.join(
    SESSIONS,
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
}

// 递归列出最近 N 天的 sessions 目录（跨日时会话文件仍写在创建当日目录下）
function recentSessionDirs(days = 7) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    out.push(path.join(
      SESSIONS,
      String(d.getFullYear()).padStart(4, "0"),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    ));
  }
  return out.filter(p => fs.existsSync(p));
}

function listSessionFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { path: p, mtime: st.mtimeMs, size: st.size };
      });
  } catch (e) {
    return [];
  }
}

function todayFilesAll() {
  const files = [];
  for (const dir of recentSessionDirs(7)) files.push(...listSessionFiles(dir));
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// ───────────────────────── 会话统计 ─────────────────────────

class SessionStats {
  constructor() {
    this.model = null;
    this.sessionTotal = 0;
    this.sessionOutput = 0;      // 生成 token（不含输入上下文）
    this.turnStartTotal = null;
    this.turnStartOutput = 0;    // 本轮开始时已累计生成 token
    this.turnId = null;
    this.turnTokens = 0;
    this.contextUsed = 0;
    this.contextWindow = 0;
    this.toolCalls = 0;
    this.toolFailures = 0;
    this.lastEventAt = null;
    // 速率（近似 ZCode 口径：output / 纯生成时长，工具等待丢弃）
    this.lastCountTs = null;
    this.lastOutput = null;
    this.lastRate = null;      // 最近一次响应 t/s
    this.turnRateSum = 0;      // 本轮 rated output
    this.turnRateMs = 0;       // 本轮 rated duration
    this.peakRate = null;      // 本轮峰值 t/s
    this.turnGenMs = 0;        // 本轮纯生成时长（Reasoning+AgentMessage 段，工具不计）
  }
}

function applyEvent(obj, stats) {
  const p = obj.payload || {};
  const ptype = p.type;
  const otype = obj.type;

  if (otype === "session_meta") {
    const prov = ((p.base_instructions || {}).provenance || {});
    if (prov.model) stats.model = prov.model;
  }
  if (ptype === "task_started") {
    const tid = p.turn_id;
    if (tid && tid !== stats.turnId) {
      stats.turnId = tid;
      stats.turnStartTotal = stats.sessionTotal;
      stats.turnStartOutput = stats.sessionOutput;
      // 每个新 turn 独立统计速度，避免把上一轮生成时长累进来
      stats.turnGenMs = 0;
      stats.turnRateSum = 0;
      stats.turnRateMs = 0;
      stats.peakRate = null;
    }
  }
  if (ptype === "model") {
    const m = p.model || p.name || p.model_name;
    if (m) stats.model = m;
  }
  if (ptype === "token_count") {
    const info = p.info || {};
    const total = info.total_token_usage || {};
    const last = info.last_token_usage || {};
    if (typeof total.total_tokens === "number") {
      stats.sessionTotal = total.total_tokens;
      if (stats.turnStartTotal === null) stats.turnStartTotal = 0;
      stats.turnTokens = Math.max(0, stats.sessionTotal - stats.turnStartTotal);
    }
    if (typeof total.output_tokens === "number") {
      stats.sessionOutput = total.output_tokens;
    }
    if (typeof last.total_tokens === "number") {
      stats.contextUsed = last.total_tokens;
    } else if (typeof last.input_tokens === "number") {
      stats.contextUsed = last.input_tokens + (last.output_tokens || 0);
    }
    if (info.model_context_window) {
      stats.contextWindow = info.model_context_window;
    }
    stats.lastEventAt = obj.timestamp;
    // 速率：相邻 token_count 事件的 delta 视为该次响应的生成时长
    const nowTs = Date.parse(obj.timestamp || "");
    if (Number.isFinite(nowTs)) {
      if (stats.lastCountTs !== null && stats.lastOutput !== null) {
        const delta = nowTs - stats.lastCountTs;
        if (delta >= 200 && delta <= 60000 && stats.lastOutput > 0) {
          const rate = stats.lastOutput / delta * 1000;
          stats.lastRate = Math.round(rate * 10) / 10;
          stats.turnRateSum += stats.lastOutput;
          stats.turnRateMs += delta;
          if (stats.peakRate === null || stats.lastRate > stats.peakRate) {
            stats.peakRate = stats.lastRate;
          }
        }
      }
      stats.lastCountTs = nowTs;
      stats.lastOutput = (last.output_tokens || 0);
    }
    // turnRate = 本轮新增生成 token / 本轮纯生成时长（精确，ZCode 口径）
    // 注意 total_tokens 包含每轮重复的输入上下文；速率只能用 output_tokens
    const turnOutput = Math.max(0, stats.sessionOutput - stats.turnStartOutput);
    if (stats.turnGenMs > 0 && turnOutput > 0) {
      const r = turnOutput / stats.turnGenMs * 1000;
      stats.turnRateSum = turnOutput;
      stats.turnRateMs = stats.turnGenMs;
      stats.lastRate = Math.round(r * 10) / 10;
      if (stats.peakRate === null || stats.lastRate > stats.peakRate) {
        stats.peakRate = stats.lastRate;
      }
    }
  }
  if (otype === "response_item" && ptype === "function_call") {
    stats.toolCalls += 1;
    if (p.status === "failed") stats.toolFailures += 1;
  }
  if (otype === "event_msg" && (ptype === "CommandExecution" || ptype === "McpToolCall")) {
    if (p.status === "failed") stats.toolFailures += 1;
  }
  // 精确生成时长：Reasoning/AgentMessage 段的 completed-started 累加，工具等待不计入（ZCode 口径）
  if (otype === "event_msg" && ptype === "item_completed") {
    const it = (p.item || {}).type;
    const s = p.started_at_ms;
    const c = p.completed_at_ms;
    if ((it === "Reasoning" || it === "AgentMessage")
        && typeof s === "number" && typeof c === "number" && c > s) {
      stats.turnGenMs += (c - s);
    }
  }
}

function parseFile(filePath, stats, startOffset = 0) {
  try {
    const size = fs.statSync(filePath).size;
    if (size <= startOffset) return size;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size - startOffset);
    fs.readSync(fd, buf, 0, buf.length, startOffset);
    fs.closeSync(fd);
    let start = 0;
    while (start < buf.length) {
      let nl = buf.indexOf(10, start);
      if (nl < 0) nl = buf.length;
      if (nl > start) {
        const line = buf.slice(start, nl).toString("utf8").trim();
        if (line) {
          try { applyEvent(JSON.parse(line), stats); } catch (e) { /* skip */ }
        }
      }
      start = nl + 1;
    }
    return size;
  } catch (e) {
    return startOffset;
  }
}

class Tracker {
  constructor() {
    this.activeFile = null;
    this.activeIno = null;
    this.offset = 0;
    this.stats = new SessionStats();
    this.todaySum = 0;
    this.todayScanAt = 0;
    this.sessionIndex = [];
    this.sessionIndexAt = 0;
    this.fileCache = new Map(); // path -> { stats, offset }
  }

  loadSessionIndex() {
    try {
      const data = fs.readFileSync(path.join(CODEX_HOME, "session_index.jsonl"), "utf8");
      this.sessionIndex = data.split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { this.sessionIndex = []; }
    this.sessionIndexAt = Date.now();
  }

  findFileByTitle(title, files) {
    if (!title) return null;
    if (Date.now() - this.sessionIndexAt > 10000) this.loadSessionIndex();
    let entry = this.sessionIndex.find(e => e.thread_name === title)
      || this.sessionIndex.find(e => e.thread_name && title.includes(e.thread_name));
    if (!entry) return null;
    return files.find(f => f.path.includes(entry.id)) || null;
  }

  tick(targetPath) {
    const files = todayFilesAll();
    if (!files.length) return null;

    // 优先用 Codex 本地状态（threads.recency_at_ms）定位的 rollout_path
    let target = null;
    if (targetPath) {
      target = files.find(f => f.path === targetPath)
        || { path: targetPath, mtime: fs.existsSync(targetPath) ? fs.statSync(targetPath).mtimeMs : 0 };
    }
    if (!target) target = files[0];
    let ino = null;
    try { ino = fs.statSync(target.path).ino; } catch (e) { return null; }

    if (target.path !== this.activeFile || ino !== this.activeIno) {
      // 切换会话：优先复用缓存的解析状态，避免大文件重头解析
      let cached = this.fileCache.get(target.path);
      if (!cached) {
        cached = { stats: new SessionStats(), offset: 0 };
        this.fileCache.set(target.path, cached);
      }
      this.activeFile = target.path;
      this.activeIno = ino;
      this.offset = cached.offset;
      this.stats = cached.stats;
    }
    this.offset = parseFile(this.activeFile, this.stats, this.offset);
    const cacheEntry = this.fileCache.get(this.activeFile);
    if (cacheEntry) cacheEntry.offset = this.offset;

    const now = Date.now();
    if (now - this.todayScanAt > 5000) {
      this.todayScanAt = now;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const startMs = dayStart.getTime();
      const todayFiles = files.filter(f => f.mtime >= startMs);
      let sum = 0;
      for (const f of todayFiles) {
        sum += this.sumTodayTokens(f.path, startMs);
      }
      this.todaySum = sum;
    }
    return this.snapshot();
  }

  sumTodayTokens(filePath, startMs) {
    let sum = 0;
    try {
      const data = fs.readFileSync(filePath, "utf8");
      for (const raw of data.split("\n")) {
        const line = raw.trim();
        if (!line || line.indexOf('"token_count"') < 0) continue;
        try {
          const obj = JSON.parse(line);
          const p = obj.payload || {};
          if (p.type !== "token_count") continue;
          const ts = Date.parse(obj.timestamp || "");
          if (!Number.isFinite(ts) || ts < startMs) continue;
          const last = ((p.info || {}).last_token_usage) || {};
          if (typeof last.total_tokens === "number") sum += last.total_tokens;
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
    return sum;
  }

  snapshot() {
    return {
      model: this.stats.model,
      sessionTotal: this.stats.sessionTotal,
      turnTokens: this.stats.turnTokens,
      contextUsed: this.stats.contextUsed,
      contextWindow: this.stats.contextWindow,
      toolCalls: this.stats.toolCalls,
      toolFailures: this.stats.toolFailures,
      todaySum: this.todaySum,
      file: path.basename(this.activeFile || ""),
      threadTitle: manualThreadTitle || "",
      lastRate: this.stats.lastRate,
      turnRate: this.stats.turnRateMs > 0
        ? Math.round(this.stats.turnRateSum / this.stats.turnRateMs * 1000 * 10) / 10
        : null,
      peakRate: this.stats.peakRate,
    };
  }
}

// ───────────────────────── 数字格式化 ─────────────────────────

function fmtTokens(n) {
  if (typeof n !== "number" || n < 0) return "-";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return String(n);
}

function fmtPct(used, win) {
  if (!win) return "-";
  return (100 * used / win).toFixed(1) + "%";
}

// ───────────────────────── ChatGPT 窗口跟踪 ─────────────────────────

function getFrontmostApp(cb) {
  const script =
    'tell application "System Events" to get name of first application process whose frontmost is true';
  execFile("osascript", ["-e", script], { timeout: 2000 }, (err, stdout) => {
    cb(err ? null : String(stdout || "").trim());
  });
}

let threadList = [];
let threadListAt = 0;
let manualRolloutPath = null;
let manualThreadTitle = null;

function loadThreadList() {
  const dbPath = path.join(CODEX_HOME, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) { threadList = []; return; }
  const sql = "SELECT title, rollout_path FROM threads WHERE archived=0 ORDER BY recency_at_ms DESC LIMIT 10";
  execFile("sqlite3", ["-json", dbPath, sql], { timeout: 2000 }, (err, stdout) => {
    if (err) { threadList = []; threadListAt = Date.now(); return; }
    try {
      const arr = JSON.parse(String(stdout || "[]"));
      threadList = arr.map(r => ({ title: r.title || "", rollout_path: r.rollout_path || "" })).filter(t => t.rollout_path);
    } catch (e) { threadList = []; }
    threadListAt = Date.now();
  });
}

function getActiveRolloutPath(cb) {
  const dbPath = path.join(CODEX_HOME, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) { cb(null); return; }
  const sql = "SELECT rollout_path FROM threads WHERE archived=0 ORDER BY recency_at_ms DESC LIMIT 1";
  execFile("sqlite3", [dbPath, sql], { timeout: 2000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    const p = String(stdout || "").trim();
    cb(p || null);
  });
}

function getChatGPTWindowTitle(cb) {
  const script = 'tell application "System Events" to tell process "ChatGPT" to get name of front window';
  execFile("osascript", ["-e", script], { timeout: 2000 }, (err, stdout) => {
    cb(err ? null : String(stdout || "").trim());
  });
}

// 遍历 ChatGPT 所有窗口，选面积最大的作为主窗口
function getChatGPTWindowBounds(cb) {
  const script = `
tell application "System Events"
  tell process "ChatGPT"
    set bestArea to 0
    set bestBounds to {}
    repeat with w in windows
      try
        set p to position of w
        set s to size of w
        set area to (item 1 of s) * (item 2 of s)
        if area > bestArea then
          set bestArea to area
          set bestBounds to {(item 1 of p), (item 2 of p), (item 1 of s), (item 2 of s)}
        end if
      end try
    end repeat
    return bestBounds
  end tell
end tell`;
  execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    const m = stdout.trim().match(/(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)/);
    if (!m) { cb(null); return; }
    cb({
      x: parseInt(m[1], 10),
      y: parseInt(m[2], 10),
      w: parseInt(m[3], 10),
      h: parseInt(m[4], 10),
    });
  });
}

// ───────────────────────── 主窗口 ─────────────────────────

let win = null;
let tray = null;
let userHidden = false;
const TRACK_TARGET = process.env.CODEX_STATUSBAR_TARGET || "ChatGPT";
const MIN_WIDTH = 220;
const MIN_HEIGHT = 22;

function createOverlay() {
  const opts = {
    type: "panel",
    width: savedSettings.width,
    height: savedSettings.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  };
  if (savedSettings.mode === "free" && savedSettings.x !== null && savedSettings.y !== null) {
    opts.x = savedSettings.x;
    opts.y = savedSettings.y;
  }
  win = new BrowserWindow(opts);
  win.setAlwaysOnTop(true, "pop-up-menu");

  win.on("moved", () => {
    if (savedSettings.mode !== "free") return;
    const b = win.getBounds();
    savedSettings.x = b.x;
    savedSettings.y = b.y;
    persistSettings();
  });
  win.on("resize", () => {
    const b = win.getBounds();
    savedSettings.width = Math.max(MIN_WIDTH, b.width);
    savedSettings.height = Math.max(MIN_HEIGHT, b.height);
    persistSettings();
  });
  win.loadFile("renderer.html");
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

function syncVisibility() {
  if (!win || win.isDestroyed()) return;
  getFrontmostApp(name => {
    if (!win || win.isDestroyed()) return;
    const shouldShow = !userHidden && name === TRACK_TARGET;
    try {
      if (shouldShow && !win.isVisible()) win.showInactive();
      else if (!shouldShow && win.isVisible()) win.hide();
    } catch (e) { /* ignore */ }
  });
}

function syncPosition() {
  if (savedSettings.mode !== "follow") return;  // free 模式下不自动跟随
  if (!win || win.isDestroyed()) return;
  getChatGPTWindowBounds(bounds => {
    if (!bounds || !win || win.isDestroyed()) return;
    // 贴 ChatGPT 主窗口右上角，留 12px 边距
    const width = Math.min(savedSettings.width, bounds.w - 24);
    const x = bounds.x + bounds.w - width - 12;
    const y = bounds.y + 48;
    try {
      win.setBounds({ x, y, width, height: savedSettings.height });
    } catch (e) { /* ignore */ }
  });
}

// ───────────────────────── 数据推送 ─────────────────────────

const tracker = new Tracker();

function pushStats() {
  if (!win || win.isDestroyed()) return;
  const snap = tracker.tick();
  console.error("[pushStats] snap.file =", snap ? (snap.file || "EMPTY") : "null");
  if (!snap) {
    win.webContents.send("statusbar-data", { empty: true, show: savedSettings.show });
    return;
  }
  snap.sessionTotalFmt = fmtTokens(snap.sessionTotal);
  snap.turnTokensFmt = fmtTokens(snap.turnTokens);
  snap.contextPctFmt = fmtPct(snap.contextUsed, snap.contextWindow);
  snap.todaySumFmt = fmtTokens(snap.todaySum);
  snap.lastRateFmt = snap.lastRate !== null ? snap.lastRate.toFixed(1) : null;
  snap.turnRateFmt = snap.turnRate !== null ? snap.turnRate.toFixed(1) : null;
  snap.peakRateFmt = snap.peakRate !== null ? snap.peakRate.toFixed(1) : null;
  snap.show = savedSettings.show;
  win.webContents.send("statusbar-data", snap);
}

// ───────────────────────── Tray 菜单 ─────────────────────────

function buildTrayMenu() {
  const SHOW_ITEMS = [
    { key: "model", label: "模型名" },
    { key: "session", label: "Σ 会话累计" },
    { key: "turn", label: "↻ 本轮消耗" },
    { key: "ctx", label: "▓ 上下文占用" },
    { key: "tools", label: "⚙ 工具调用" },
    { key: "today", label: "📅 今日新增" },
    { key: "rate", label: "⚡ 生成速度" },
  ];
  if (Date.now() - threadListAt > 15000) loadThreadList();
  const currentRollout = manualRolloutPath || tracker.activeFile;
  const threadSub = threadList.map(t => ({
    label: (t.title || "(未命名)").slice(0, 46),
    type: "radio",
    checked: t.rollout_path === currentRollout,
    click: () => {
      manualRolloutPath = t.rollout_path;
      manualThreadTitle = t.title;
      pushStats();
    }
  }));
  return Menu.buildFromTemplate([
    { label: "对话", submenu: threadSub },
    { type: "separator" },
    { label: "显示 / 隐藏状态栏", click: () => {
        userHidden = !userHidden;
        if (userHidden) { if (win && !win.isDestroyed()) win.hide(); }
        else syncVisibility();
      }
    },
    { type: "separator" },
    {
      label: "跟随 ChatGPT 窗口位置",
      type: "checkbox",
      checked: savedSettings.mode === "follow",
      click: (item) => {
        savedSettings.mode = item.checked ? "follow" : "free";
        if (savedSettings.mode === "free" && win && !win.isDestroyed()) {
          const b = win.getBounds();
          savedSettings.x = b.x; savedSettings.y = b.y;
        }
        persistSettings();
      }
    },
    {
      label: "显示项",
      submenu: SHOW_ITEMS.map(it => ({
        label: it.label,
        type: "checkbox",
        checked: !!savedSettings.show[it.key],
        click: (item) => {
          savedSettings.show[it.key] = item.checked;
          persistSettings();
        }
      }))
    },
    { type: "separator" },
    { label: "退出状态栏", click: () => app.quit() },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, "tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  console.error("[tray] icon path:", iconPath, "empty:", icon.isEmpty());
  if (icon.isEmpty()) {
    // fallback: 用系统图标
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("Σ");
  } else {
    tray = new Tray(icon);
  }
  tray.setToolTip("Codex Token 状态栏\n左键：显示/隐藏\n右键：菜单");
  // 注意：不调用 tray.setContextMenu()，否则 click 事件在 macOS 上不会触发
  tray.on("click", () => {
    userHidden = !userHidden;
    if (userHidden) {
      if (win && !win.isDestroyed()) win.hide();
    } else {
      syncVisibility();
    }
  });
  tray.on("right-click", () => {
    tray.popUpContextMenu(buildTrayMenu());
  });
}

// ───────────────────────── IPC ─────────────────────────

function registerIpc() {
  ipcMain.on("statusbar-resize", (_e, { width, height }) => {
    if (!win || win.isDestroyed()) return;
    const w = Math.max(MIN_WIDTH, Math.round(width));
    const h = Math.max(MIN_HEIGHT, Math.round(height));
    win.setSize(w, h);
    savedSettings.width = w;
    savedSettings.height = h;
    persistSettings();
  });
  ipcMain.on("statusbar-move-to", (_e, { x, y }) => {
    if (!win || win.isDestroyed()) return;
    try {
      const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      const wa = display.workArea;
      const cx = Math.min(Math.max(Math.round(x), wa.x), wa.x + wa.width - MIN_WIDTH);
      const cy = Math.min(Math.max(Math.round(y), wa.y), wa.y + wa.height - MIN_HEIGHT);
      win.setPosition(cx, cy);
      savedSettings.x = cx;
      savedSettings.y = cy;
      savedSettings.mode = "free";
      persistSettings();
    } catch (e) { /* ignore */ }
  });
  ipcMain.handle("statusbar-get-bounds", () => {
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: savedSettings.width, height: savedSettings.height };
    return win.getBounds();
  });
  ipcMain.on("statusbar-set-free", () => {
    if (savedSettings.mode !== "free") {
      savedSettings.mode = "free";
      if (win && !win.isDestroyed()) {
        const b = win.getBounds();
        savedSettings.x = b.x; savedSettings.y = b.y;
      }
      persistSettings();
      rebuildTrayMenu();
    }
  });
}

// ───────────────────────── app 启动 ─────────────────────────

loadSettings();
registerIpc();

app.whenReady().then(() => {
  // 先切换为 accessory（Dock 隐藏），必须在创建任何窗口之前
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.hide();
      console.error("[main] dock.hide() called first, visible:", app.dock.isVisible());
    } catch (e) {
      console.error("[main] dock.hide() failed:", e.message);
    }
  }
  try {
    createTray();
    console.error("[main] tray created");
  } catch (e) {
    console.error("[main] tray failed:", e.message);
  }
  try {
    createOverlay();
    console.error("[main] overlay created");
  } catch (e) {
    console.error("[main] overlay failed:", e.message);
  }
  // 兜底：overlay 创建完成后再 hide 一次
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
    console.error("[main] final dock.hide(), visible:", app.dock.isVisible());
  }
  // 位置同步
  setInterval(syncPosition, 500);
  syncPosition();
  // 可见性
  setInterval(syncVisibility, 500);
  syncVisibility();
  // 数据推送
  setInterval(pushStats, 1000);
  pushStats();
});

app.on("window-all-closed", () => app.quit());
