/** @file
 * Minimal Chrome DevTools Protocol driver for headless screenshots.
 *
 * It launches the locally installed Chrome, talks to it over the built-in
 * WebSocket client, and exposes only what the website screenshot capture
 * needs: navigation, script evaluation, polling waits, real mouse clicks,
 * viewport/color-scheme emulation, and PNG capture. It has no npm
 * dependencies, so the capture script runs with a plain `node`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/** Resolve a Chrome binary from CHROME_PATH, the platform defaults, or PATH. */
export function findChrome(env = process.env, platform = process.platform) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES[platform] ?? []) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      const full = join(dir, candidate);
      if (dir && existsSync(full)) return full;
    }
  }
  throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH.");
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => this.#dispatch(JSON.parse(event.data)));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Chrome connection closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  /** Resolve with the first `method` event for `sessionId` that passes `predicate`. */
  waitForEvent(method, { sessionId, timeout = 30_000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out after ${timeout}ms waiting for ${method}`));
      }, timeout);
      const listener = (message) => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        if (!predicate(message.params)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    this.socket.close();
  }
}

/** One browser tab. Every call goes through the tab's flat CDP session. */
export class Page {
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params) {
    return this.connection.send(method, params, this.sessionId);
  }

  /** Fixed CSS viewport at the given device pixel ratio (2 = retina-sharp PNGs). */
  async setViewport({ width, height, deviceScaleFactor = 2 }) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  }

  /** Emulate the OS appearance and turn off motion for stable frames. */
  async setColorScheme(scheme) {
    await this.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: scheme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
  }

  /** Run `source` before any page script on every navigation. */
  async addInitScript(source) {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async goto(url, { timeout = 30_000 } = {}) {
    const loaded = this.connection.waitForEvent("Page.loadEventFired", { sessionId: this.sessionId, timeout });
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`Navigation to ${url} failed: ${errorText}`);
    await loaded;
  }

  /** Evaluate `fn(...args)` in the page and return its JSON-serializable result. */
  async evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`Page script failed: ${detail}`);
    }
    return result.value;
  }

  /** Poll `fn(...args)` until it returns a truthy value, then return it. */
  async waitFor(fn, args = [], { timeout = 20_000, interval = 250, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(fn, ...args);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    throw new Error(`Timed out after ${timeout}ms waiting for ${what}${lastError ? ` (${lastError.message})` : ""}`);
  }

  /** Click the element `locate(...args)` returns, with real mouse events. */
  async click(locate, args = [], { what = "element", timeout } = {}) {
    const point = await this.waitFor(
      (source, sourceArgs) => {
        const element = new Function(`return (${source})`)()(...sourceArgs);
        if (!element) return null;
        element.scrollIntoView({ block: "center", inline: "center" });
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      },
      [String(locate), args],
      { what, timeout },
    );
    const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  async press(key) {
    const codes = { Escape: 27, Enter: 13 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 };
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyDown" });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  /** PNG of `clip` (CSS pixels, page coordinates) or of the whole viewport. */
  async screenshot(clip) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  }

  async close() {
    await this.connection.send("Target.closeTarget", { targetId: this.targetId });
  }
}

/** Launch headless Chrome with a throwaway profile. Call `close()` when done. */
export async function launchChrome({ headless = true, executablePath = findChrome() } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), "cheers-shots-"));
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--mute-audio",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child = spawn(executablePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${stderr}`)), 20_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with code ${code}:\n${stderr}`));
    });
  });
  const connection = await CdpConnection.connect(endpoint);

  return {
    async newPage() {
      const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(connection, sessionId, targetId);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      return page;
    },
    async close() {
      connection.close();
      child.kill();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
