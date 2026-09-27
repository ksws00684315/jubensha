/* R9 浏览器实机走查驱动：用本机 Chrome（headless=new，独立临时 profile）经 CDP 执行动作清单。
 *
 * 为什么不用 Qoder 内置 Browser 面板：面板未打开时页面 innerWidth=0、document.hidden=true，
 * 截图与移动端布局判定都无意义（NATIVE_BROWSER_VIEWPORT_UNAVAILABLE）。CDP 可精确设定
 * 1280x800 / 375x812 视口，并能汇总控制台 error —— R9 需要的是这两样。
 *
 * 用法：
 *   node scripts/e2e/browser.mjs --plan=<file.json> [--keep-browser] [--width= --height= --mobile --shot-prefix=m]
 *   node scripts/e2e/browser.mjs --shutdown
 * plan: { "viewport": {width,height,mobile?}, "settleMs": 400, "actions": [ ... ] }
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = process.cwd();
const E2E_DIR = path.join(ROOT, ".e2e");
const CHROME_INFO = path.join(E2E_DIR, "chrome.json");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = (() => {
  const out = {};
  const vars = [];
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      out[a] = true;
      continue;
    }
    const [, key, value] = m;
    // --var 可重复给（写两个 --var 时后者覆盖前者会让人误以为变量没生效，attach 才报“没有可附着的标签页”）
    if (key === "var" && value !== undefined) {
      vars.push(...value.split(","));
      continue;
    }
    out[key] = value === undefined ? true : value;
  }
  out.var = vars.join(",");
  return out;
})();

function log(...a) {
  console.log("[e2e:browser]", ...a);
}
function fail(msg) {
  console.error("[e2e:browser] FAILED:", msg);
  process.exitCode = 1;
  throw new Error(msg);
}

function chromeAlive(port) {
  const r = spawnSync("/usr/bin/curl", ["-s", "-m", "2", `http://127.0.0.1:${port}/json/version`], { encoding: "utf8" });
  return r.status === 0 && /Browser/.test(r.stdout ?? "");
}

async function startChrome() {
  if (!existsSync(CHROME_BIN)) fail(`未找到 Chrome：${CHROME_BIN}`);
  const saved = existsSync(CHROME_INFO) ? JSON.parse(readFileSync(CHROME_INFO, "utf8")) : null;
  if (saved && chromeAlive(saved.port)) return saved;
  const port = Number(argv["cdp-port"] ?? 9333);
  const profile = path.join(E2E_DIR, "chrome-profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--hide-scrollbars",
      "--window-size=1280,800",
      "--lang=zh-CN",
      "about:blank",
    ],
    { stdio: "ignore", detached: true }
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (chromeAlive(port)) break;
    await sleep(250);
  }
  if (!chromeAlive(port)) fail(`Chrome 调试端口 ${port} 未就绪`);
  const info = { pid: child.pid, port, profile };
  writeFileSync(CHROME_INFO, JSON.stringify(info, null, 2) + "\n");
  log(`Chrome headless 已启动 pid=${child.pid} cdp=${port} profile=${profile}`);
  return info;
}

function ownChromePids(profile) {
  const r = spawnSync("pgrep", ["-f", `user-data-dir=${profile}`], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map((x) => Number(x.trim())).filter(Boolean);
}

async function shutdownChrome() {
  const saved = existsSync(CHROME_INFO) ? JSON.parse(readFileSync(CHROME_INFO, "utf8")) : null;
  const port = saved?.port ?? Number(argv["cdp-port"] ?? 9333);
  const pids = ownChromePids(path.join(E2E_DIR, "chrome-profile"));
  if (!pids.length) {
    rmSync(CHROME_INFO, { force: true });
    return log("没有本 profile 的 Chrome 进程");
  }
  // 只杀带我们自己 --user-data-dir 的进程（主进程 + helper），不碰用户日常 Chrome
  for (const pid of pids) spawnSync("kill", [String(pid)], { stdio: "pipe" });
  log(`已关闭本 profile 的 Chrome ${pids.length} 个进程`);
  for (let i = 0; i < 40; i++) {
    if (!chromeAlive(port) && !ownChromePids(path.join(E2E_DIR, "chrome-profile")).length) break;
    await sleep(250);
  }
  if (chromeAlive(port)) fail(`关闭后端口 ${port} 仍在监听，请人工检查`);
  rmSync(CHROME_INFO, { force: true });
  // profile 里留着默认上下文的 cookie / localStorage（管理员身份、座位凭证），不清会让下一轮「首访锁定态」失真
  rmSync(path.join(E2E_DIR, "chrome-profile"), { recursive: true, force: true });
}

/** 极简 CDP 客户端：单个 WebSocket，按 sessionId 路由。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")));
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  off(fn) {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
}

const HELPERS = `
window.__r9 = (function () {
  const find = (sel) => {
    if (sel.startsWith("label:")) {
      const want = sel.slice(6).trim();
      const labels = Array.from(document.querySelectorAll("label")).filter((l) => (l.textContent || "").replace(/\\s+/g, " ").trim().includes(want));
      for (const l of labels) {
        const c = l.querySelector("input,select,textarea");
        if (c) return c;
      }
      return null;
    }
    if (sel.startsWith("text:")) {
      const want = sel.slice(5).trim();
      const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const textOf = (el) => norm(el.textContent || el.value || el.placeholder || el.getAttribute("aria-label"));
      const pool = Array.from(document.querySelectorAll('a,button,input,textarea,select,label,[role="button"],[role="tab"],summary')).filter((el) => textOf(el).includes(want));
      const exact = pool.filter((el) => textOf(el) === want);
      const cands = exact.length ? exact : pool;
      if (cands.length) return cands.find((el) => el.offsetParent !== null || el === document.activeElement) || cands[0];
      // 交互元素里没有，再退到「自己的文本节点」含该串的元素（标题、说明文字）——用于存在性断言
      const own = (el) => norm(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
      const leaves = Array.from(document.querySelectorAll("main *,header *")).filter((el) => own(el).includes(want));
      const strict = leaves.filter((el) => norm(el.textContent) === want);
      const list = strict.length ? strict : leaves;
      return list.find((el) => el.offsetParent !== null) || list[0] || null;
    }
    return document.querySelector(sel);
  };
  return {
    find,
    exists: (sel) => !!find(sel),
    textOf: (sel) => {
      const el = sel === "body" ? document.body : find(sel);
      return el ? (el.value !== undefined && el.tagName === "TEXTAREA" ? el.value : el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 400) : null;
    },
    box: (sel) => {
      const el = find(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    },
    layout: () => ({
      inner: [window.innerWidth, window.innerHeight],
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
    }),
  };
})();
`;

/** 一个页面（CDP target）：事件采集 + 动作执行。 */
class Page {
  constructor(cdp, id, sessionId) {
    this.cdp = cdp;
    this.id = id;
    this.sessionId = sessionId;
    this.consoleErrors = [];
    this.exceptions = [];
    this.requests = [];
    this.events = [];
    this.cdp.on((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      const p = msg.params ?? {};
      if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") {
        this.push(this.consoleErrors, this.fmtArgs(p.args));
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.push(this.exceptions, p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception");
      } else if (msg.method === "Log.entryAdded") {
        if (p.entry?.level === "error") this.push(this.consoleErrors, `${p.entry.source ?? "log"}: ${p.entry.text} @ ${p.entry.url ?? ""}`.slice(0, 300));
      } else if (msg.method === "Network.requestWillBeSent") {
        // 只记「URL 里带了凭证」这件事，不记凭证值本身（报告文件也是本地产物，别留明文口令）
        const url = p.request?.url ?? "";
        this.requests.push({
          url: url.replace(/(token|dmtoken|ticket)=([^&]+)/g, "$1=‹redacted›"),
          method: p.request?.method,
          hasTokenQuery: /[?&]token=/.test(url),
          hasTicketQuery: /[?&]ticket=/.test(url),
        });
      } else if (msg.method === "Page.javascriptDialogOpening") {
        this.events.push(`dialog:${p.message}`);
        this.cdp.send("Page.handleJavaScriptDialog", { accept: true }, this.sessionId).catch(() => {});
      }
    });
    this.seenErrors = new Set();
  }
  push(list, text) {
    if (!text) return;
    const key = `${list === this.consoleErrors ? "c" : "e"}|${text}`;
    if (this.seenErrors.has(key)) return;
    this.seenErrors.add(key);
    list.push(text);
  }
  fmtArgs(args = []) {
    return args
      .map((a) => a.value ?? a.description ?? a.type ?? "")
      .join(" ")
      .slice(0, 300);
  }
  async eval(expr) {
    const r = await this.cdp.send(
      "Runtime.evaluate",
      { expression: `(async function(){${HELPERS}\n${expr}})()`, returnByValue: true, awaitPromise: true },
      this.sessionId
    );
    if (r.exceptionDetails) throw new Error(`页面脚本异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async reload() {
    const loaded = new Promise((res) => {
      const off = (msg) => {
        if (msg.sessionId === this.sessionId && msg.method === "Page.loadEventFired") {
          this.cdp.off(off);
          res();
        }
      };
      this.cdp.on(off);
      void off;
    });
    await this.cdp.send("Page.reload", {}, this.sessionId);
    await Promise.race([loaded, sleep(15000)]);
  }
  async goto(url) {
    const loaded = new Promise((res) => {
      const off = this.cdp.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === "Page.loadEventFired") res();
      });
      void off;
    });
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
    await Promise.race([loaded, sleep(15000)]);
  }
  async shot(file, dir) {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, this.sessionId);
    const out = path.join(dir, file);
    writeFileSync(out, Buffer.from(r.data, "base64"));
    log(`  📸 ${file}`);
  }
  async clickAt(box) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, this.sessionId);
  }
  async click(sel) {
    const box = await this.eval(`return __r9.box(${JSON.stringify(sel)});`);
    if (!box || box.w === 0) throw new Error(`点击目标不可见: ${sel}`);
    await this.clickAt(box);
  }
  /** 点第一个匹配 CSS 选择器的元素（对 Tailwind 类名等非语义目标有用）。 */
  async clickFirst(sel) {
    const box = await this.eval(
      `return (function(){const els=[...document.querySelectorAll(${JSON.stringify(sel)})];if(!els.length)return null;` +
      `const el=els[0];el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();` +
      `return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()`
    );
    if (!box || box.w === 0) throw new Error(`没有可点击元素: ${sel}`);
    await this.clickAt(box);
  }
  async type(sel, text) {
    const box = await this.eval(`return __r9.box(${JSON.stringify(sel)});`);
    if (!box) throw new Error(`输入框不存在: ${sel}`);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, this.sessionId);
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
  }
  async select(sel, value) {
    return this.eval(
      `return (function(){const el=__r9.find(${JSON.stringify(sel)});if(!el)return "missing";` +
        `const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;` +
        `Object.getOwnPropertyDescriptor(proto,"value").set.call(el, ${JSON.stringify(String(value))});` +
        `el.dispatchEvent(new Event("change",{bubbles:true}));el.dispatchEvent(new Event("input",{bubbles:true}));` +
        `return el.value;})()`
    );
  }
  async key(name) {
    for (const type of ["keyDown", "keyUp"]) {
      await this.cdp.send(
        "Input.dispatchKeyEvent",
        type === "keyDown" ? { type, key: name, code: name === "Enter" ? "Enter" : name, windowsVirtualKeyCode: 13 } : { type, key: name, code: name },
        this.sessionId
      );
    }
  }
}

async function main() {
  if (argv.shutdown) {
    await shutdownChrome();
    return;
  }
  if (!argv.plan) fail("缺少 --plan=<file.json>");
  const planPath = path.join(ROOT, String(argv.plan));
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const up = JSON.parse(readFileSync(path.join(E2E_DIR, "up.json"), "utf8"));
  const BASE = `http://127.0.0.1:${up.port}`;
  const screens = path.join(E2E_DIR, "screens", plan.dir ?? plan.step ?? "tmp");
  mkdirSync(screens, { recursive: true });
  const vp = { ...(plan.viewport ?? { width: 1280, height: 800 }) };
  if (argv.width) vp.width = Number(argv.width);
  if (argv.height) vp.height = Number(argv.height);
  if (argv.mobile) vp.mobile = true;
  const shotPrefix = String(argv["shot-prefix"] ?? "");
  const settle = plan.settleMs ?? 400;

  const info = await startChrome();
  const version = await (await fetch(`http://127.0.0.1:${info.port}/json/version`)).json();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, targetId, sessionId);
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await cdp.send(m, {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: !!vp.mobile },
    sessionId
  );
  if (vp.mobile) {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }, sessionId);
  }
  log(`视口 ${vp.width}x${vp.height}${vp.mobile ? "（移动）" : "（桌面）"}，目标 ${BASE}`);

  const report = { plan: String(argv.plan), viewport: vp, base: BASE, steps: [], saved: {}, failures: [], shotPrefix };
  for (const pair of String(argv.var ?? "").split(",").filter(Boolean)) {
    const [k, ...rest] = pair.split("=");
    report.saved[k.trim()] = rest.join("=");
  }
  const named = {};
  const contexts = [];
  named.host = page;
  const subst = (s) =>
    String(s).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, k) => {
      if (k === "BASE") return BASE;
      if (k === "ADMIN_TOKEN") return String(up.adminToken ?? "");
      return report.saved[k] === undefined ? m : String(report.saved[k]);
    });
  let state = { page };
  const t0 = Date.now();
  if (plan.adminSession) await seedAdminSession();

  const openTab = async (name, sessionId, targetId) => {
    const p = new Page(cdp, targetId, sessionId);
    for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await cdp.send(m, {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: !!vp.mobile }, sessionId);
    named[name] = p;
    return p;
  };
  const exists = (p, sel) => p.eval(`return __r9.exists(${JSON.stringify(subst(sel))});`);

  /**
   * 生产构建的 e2e 实例默认 ROOM_CREATE_POLICY=admin（决策 D2），走 UI 建含 AI 座位的房间
   * 得先有管理会话。这里用真实解锁接口换 cookie 再种进浏览器，等同于人在「设置」页输口令；
   * 口令只在进程内出现，不写进计划文件，也不进报告。
   */
  async function seedAdminSession() {
    const res = await fetch(`${BASE}/api/admin/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: up.adminToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) fail(`注入管理员会话失败：HTTP ${res.status}（解锁接口可能被限流，稍后重试）`);
    const pair = (res.headers.get("set-cookie") ?? "").split(";")[0];
    const [name, ...rest] = pair.split("=");
    if (!name || !rest.length) fail("解锁响应里没有 Set-Cookie，无法注入会话");
    await cdp.send("Network.setCookie", { name, value: rest.join("="), url: BASE, httpOnly: true, sameSite: "Lax" }, page.sessionId);
    log("已注入管理员会话（供 UI 创建含 AI 座位的房间）");
  }

  /** 执行单步；If 变体在目标不存在时跳过而非失败。返回 'ok' 或 'skip:<原因>'。 */
  const execOne = async (p, action) => {
    if (action.nav) {
      await p.goto(subst(action.nav));
      await sleep(settle);
    } else if (action.waitSelector) {
      const deadline = Date.now() + (action.timeoutMs ?? 30000);
      while (Date.now() < deadline) {
        if (await exists(p, action.waitSelector)) return "ok";
        await sleep(500);
      }
      throw new Error(`等待元素超时: ${action.waitSelector}`);
    } else if (action.waitJs) {
      // 瞬时文案（如「已选择，等待其他玩家搜证」）可能因阶段立刻推进而完全不渲染，
      // 这类步骤要等「结果态」而不是等某一条文案。
      const deadline = Date.now() + (action.timeoutMs ?? 30000);
      while (Date.now() < deadline) {
        if (await p.eval(subst(action.waitJs))) return "ok";
        await sleep(500);
      }
      throw new Error(`等待条件超时: ${action.label ?? action.waitJs}`);
    } else if (action.reload) {
      await p.reload();
      await sleep(settle);
    } else if (action.waitMs) await sleep(Number(action.waitMs));
    else if (action.click) {
      await p.click(subst(action.click));
      await sleep(action.settleMs ?? settle);
    } else if (action.clickIf) {
      if (!(await exists(p, action.clickIf))) return `skip:${subst(action.clickIf)}`;
      await p.click(subst(action.clickIf));
      await sleep(action.settleMs ?? settle);
    } else if (action.type) {
      await p.type(subst(action.type), subst(action.value ?? ""));
      await sleep(150);
    } else if (action.typeIf) {
      if (!(await exists(p, action.typeIf))) return `skip:${subst(action.typeIf)}`;
      await p.type(subst(action.typeIf), subst(action.value ?? ""));
      await sleep(150);
    } else if (action.pick) {
      const v = await p.select(subst(action.pick), subst(action.value ?? ""));
      log(`  ⤷ 选择 ${action.pick} → ${String(v).slice(0, 24)}`);
      if (v === "missing") throw new Error(`下拉框不存在: ${action.pick}`);
      await sleep(action.settleMs ?? settle);
    } else if (action.pickIf) {
      if (!(await exists(p, action.pickIf))) return `skip:${subst(action.pickIf)}`;
      const v = await p.select(subst(action.pickIf), subst(action.value ?? ""));
      if (v === "missing") return `skip:${subst(action.pickIf)}`;
      await sleep(action.settleMs ?? settle);
    } else if (action.clickFirst) {
      if (action.clickFirst.startsWith("optional:")) {
        const sel = action.clickFirst.slice(9);
        const found = await p.eval(`return !!document.querySelector(${JSON.stringify(sel)});`);
        if (!found) return `skip:${sel}`;
        await p.clickFirst(sel);
      } else await p.clickFirst(subst(action.clickFirst));
      await sleep(action.settleMs ?? settle);
    } else if (action.press) {
      await p.key(String(action.press));
      await sleep(action.settleMs ?? settle);
    } else if (action.shot) await p.shot(shotPrefix + String(subst(action.shot)), screens);
    else if (action.collect) {
      const v = await p.eval(subst(action.collect));
      report.saved[action.save ?? `k${report.steps.length}`] = v;
      log(`  ↱ ${action.save ?? "collect"} = ${JSON.stringify(v).slice(0, 200)}`);
    } else if (action.assert) {
      const v = await p.eval(subst(action.assert));
      if (!v) throw new Error(`断言失败: ${action.label ?? action.assert}`);
    } else if (action.tabNew) {
      // isolated:true 走独立 browser context —— 与「无痕窗口只带房间码」等价（不共享 localStorage/cookie）
      let browserContextId;
      if (action.isolated) {
        const ctx = await cdp.send("Target.createBrowserContext", {});
        browserContextId = ctx.browserContextId;
        contexts.push(browserContextId);
      }
      const { targetId: nt } = await cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
      const { sessionId: ns } = await cdp.send("Target.attachToTarget", { targetId: nt, flatten: true });
      const np = await openTab(action.as ?? `tab${Object.keys(named).length + 1}`, ns, nt);
      await np.goto(subst(action.tabNew));
      await sleep(settle);
      // 新建标签页即为当前操作对象（否则后续步骤会打在旧标签上）
      state.page = np;
      log(`  ⧉ 新标签页 ${action.as ?? ""}${action.isolated ? "（独立上下文）" : ""}`);
    } else if (action.attach) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const inc = (Array.isArray(action.urlIncludes) ? action.urlIncludes : action.urlIncludes ? [action.urlIncludes] : []).map(subst);
      const cand = targetInfos.filter(
        (t) => t.type === "page" && (!inc.length || inc.some((s) => s && t.url.includes(s))) && (action.isolated ? Boolean(t.browserContextId) : !t.browserContextId)
      );
      if (!cand.length) throw new Error(`没有可附着的标签页 urlIncludes=${JSON.stringify(inc)} isolated=${!!action.isolated}`);
      // 多个候选（同 URL 的观众页/玩家页）时按 requireSelector 挑出真正持有座位凭证的那个
      let ap = null;
      for (const t of cand.reverse()) {
        const { sessionId: as } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const p2 = await openTab(action.attach, as, t.targetId);
        if (!action.requireSelector || (await p2.eval(`return __r9.exists(${JSON.stringify(subst(action.requireSelector))});`))) {
          ap = p2;
          break;
        }
        delete named[action.attach];
        await cdp.send("Target.detachFromTarget", { sessionId: as }).catch(() => {});
      }
      if (!ap) throw new Error(`附着失败：没有标签页满足 ${action.requireSelector}`);
      state.page = ap;
      log(`  ⧉ 附着已有标签页 ${action.attach}（${ap.id.slice(0, 8)}）`);
    } else if (action.useTab) {
      const next = named[String(action.useTab)];
      if (!next) throw new Error(`标签页不存在: ${action.useTab}`);
      state.page = next;
      log(`  ⧉ 切换到标签 ${action.useTab}`);
    } else if (action.tabList) {
      report.saved[action.tabList] = await Promise.all(
        Object.entries(named).map(async ([name, p]) => ({ name, url: await p.eval("return location.href;") }))
      );
    } else throw new Error(`未知动作: ${JSON.stringify(action).slice(0, 80)}`);
    return "ok";
  };

  const runOne = async (action) => {
    const p = state.page;
    if (!action.until) return { status: await execOne(p, action) };
    const u = action.until;
    const deadline = Date.now() + (u.maxMs ?? 300000);
    let i = 0;
    for (; Date.now() < deadline; i++) {
      report.saved.iter = String(i);
      if (u.done && (await exists(p, u.done))) return { status: "ok", loops: i };
      for (const sub of u.steps ?? []) {
        try {
          const st = await execOne(state.page, sub);
          if (st !== "ok") log(`  · 轮${i} ${st}`);
        } catch (e) {
          if (u.ignoreErrors === false) throw e;
          log(`  · 轮${i} 忽略：${String(e.message).slice(0, 90)}`);
        }
      }
      await sleep(u.tickMs ?? 1500);
    }
    throw new Error(`until 超时未完成: ${u.done}（已循环 ${i} 轮）`);
  };

  for (const action of plan.actions) {
    const label = action.label ?? Object.keys(action).join("+");
    try {
      const r = await runOne(action);
      // 跳过（If 变体目标不存在）也要留痕，否则「这一步没做」和「这一步做了」在报告里长得一样
      report.steps.push({ label, ok: true, skipped: String(r.status).startsWith("skip:") ? String(r.status).slice(5) : undefined, loops: r.loops });
    } catch (e) {
      report.steps.push({ label, ok: false, error: String(e.message).slice(0, 300) });
      report.failures.push({ label, error: String(e.message).slice(0, 300) });
      log(`  ✗ ${label}: ${e.message}`);
      if (plan.stopOnFailure !== false) break;
    }
  }

  const allPages = [...new Set([page, ...Object.values(named)])];
  const consoleErrors = allPages.flatMap((p) => p.consoleErrors);
  const exceptions = allPages.flatMap((p) => p.exceptions);
  // CSP 违规单独计数：转强制执行后「违规 0」是判据，不能只混在 console error 总数里
  const cspViolations = consoleErrors.filter((t) => /Content Security Policy|Refused to (?:load|execute|apply|display|connect|install|bypass)/i.test(t));
  const tokenRequests = [...new Set(allPages.flatMap((p) => p.requests.filter((r) => r.hasTokenQuery).map((r) => r.url)))];
  // 正面侧证：token= 归零要和 ticket>0 一起看，否则「0」也可能只是根本没建流
  const ticketRequests = [...new Set(allPages.flatMap((p) => p.requests.filter((r) => r.hasTicketQuery).map((r) => r.url)))];
  const layout = await state.page.eval("return __r9.layout();").catch(() => null);
  const pages = Object.fromEntries(
    Object.entries(named).map(([name, p]) => [
      name,
      {
        consoleErrors: p.consoleErrors.length,
        exceptions: p.exceptions.length,
        tokenQueries: p.requests.filter((r) => r.hasTokenQuery).length,
        ticketQueries: p.requests.filter((r) => r.hasTicketQuery).length,
      },
    ])
  );
  writeFileSync(
    // 同一 plan 在桌面/移动各跑一遍时报告不能互相覆盖：文件名带上 --shot-prefix（d / m）
    path.join(screens, `${plan.step ?? "run"}${shotPrefix ? `-${shotPrefix}` : ""}-report.json`),
    JSON.stringify({ ...report, consoleErrors, cspViolations, exceptions, tokenQueryRequests: tokenRequests, ticketQueryRequests: ticketRequests, layout, pages, elapsedMs: Date.now() - t0 }, null, 2) + "\n"
  );
  appendFileSync(
    path.join(E2E_DIR, "screens", "console-errors.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), plan: String(argv.plan), step: plan.step, viewport: vp, consoleErrors, cspViolations, exceptions }) + "\n"
  );
  log(`完成：${report.steps.length} 步，失败 ${report.failures.length}，控制台 error ${consoleErrors.length}（其中 CSP 违规 ${cspViolations.length}），未捕获异常 ${exceptions.length}，URL 凭证 token= ${tokenRequests.length} 条 / ticket= ${ticketRequests.length} 条`);
  // --keep-browser 只保留标签页（供下一步 plan 附着），WebSocket 必须关掉否则进程不退出
  if (!argv["keep-browser"]) {
    for (const p of allPages) await cdp.send("Target.closeTarget", { targetId: p.id }).catch(() => {});
    for (const ctx of contexts) await cdp.send("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {});
  }
  cdp.ws.close();
  if (report.failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[e2e:browser] 失败:", e.message);
  process.exit(1);
});
