/**
 * Dependency-free, offline Chromium layout gate. Requires Node 24 and installed
 * Chrome/Chromium (CHROME_PATH may select it). No application server is started.
 *
 * node scripts/check-hud-layout.mjs --output-dir /tmp/hud-layout
 * git show <sha>:typescript/src/mcp/dashboard-v1.html > /tmp/baseline.html
 * node scripts/check-hud-layout.mjs --html /tmp/baseline.html
 *
 * The exact input bytes are served by CDP request interception. Only synthetic
 * fixtures are supplied; every other request is blocked. Artifacts record both
 * the checkout SHA and the input SHA-256, including for --html baseline runs.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://hud-layout.test";
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1400, height: 900 },
  { width: 1366, height: 768 },
];

export function parseArgs(args) {
  const options = { html: join(repoRoot, "typescript/src/mcp/dashboard-v1.html") };
  const names = { "--html": "html", "--output-dir": "outputDir" };
  for (let index = 0; index < args.length; index += 1) {
    const name = names[args[index]];
    if (!name) throw new Error(`Unknown option: ${args[index]}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`${args[index]} requires a value`);
    }
    options[name] = resolve(args[++index]);
  }
  return options;
}

export function fixtureFor(name) {
  if (!["empty", "populated"].includes(name)) throw new Error(`Unknown fixture: ${name}`);
  return {
    status: {
      status: "ok",
      version: "TEST ONLY",
      sourceVersion: "offline-layout-fixture",
      zState: "active",
      timezone: "Etc/UTC",
      checkedAt: "2026-01-01T00:00:00.000Z",
      provider: {
        name: "json",
        reachability: "ok",
        authentication: "not-required",
        schemaCompatibility: "compatible",
      },
      layers: { runtime: { status: "ready" } },
      integrations: [],
      reasoning: { status: "not-configured", provider: null, model: null },
      reconciliation: { state: "disabled", enabled: false },
    },
    tasks:
      name === "empty"
        ? []
        : Array.from({ length: 4 }, (_, index) => ({
            id: `layout-test-${index}`,
            title: index === 0 ? "[TEST ONLY] Now" : `[TEST ONLY] Next ${index}`,
            category: "work",
            completed: false,
            createdAt: index + 1,
          })),
    reminders: [],
    inbox: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: [
        { source: "maintenance", status: "available", checkedAt: "2026-01-01T00:00:00.000Z" },
      ],
      items:
        name === "empty"
          ? []
          : Array.from({ length: 6 }, (_, index) => ({
              itemId: `layout-inbox-${index}`,
              kind: "maintenance-due-soon",
              explanation: "Synthetic browser-layout fixture; no live data.",
              sourceSubsystem: "maintenance",
              sourceRecordId: `layout-record-${index}`,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              status: "open",
              actionRequired: false,
              title: `[TEST ONLY] Tactical queue entry ${index + 1} awaiting the visibility and scroll check`,
              severity: "normal",
            })),
    },
  };
}

// Compare every text line against every clipping ancestor, rather than merely
// testing whether the element exists or its bounding box has nonzero height.
export function assessNoOverlap(first, second) {
  return first.rects.some((a) =>
    second.rects.some(
      (b) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
    ),
  )
    ? [`${first.label}: overlaps ${second.label}`]
    : [];
}

export function assessVisibility(measurement) {
  const failures = [];
  const { label, rects, clips, hidden, occluded } = measurement;
  if (!rects.length) failures.push(`${label}: no rendered content`);
  for (const reason of hidden) failures.push(`${label}: hidden (${reason})`);
  for (const rect of rects) {
    for (const clip of clips) {
      if (
        rect.left < clip.left - 0.5 ||
        rect.top < clip.top - 0.5 ||
        rect.right > clip.right + 0.5 ||
        rect.bottom > clip.bottom + 0.5
      ) {
        failures.push(`${label}: clipped by ${clip.label} (${JSON.stringify({ rect, clip })})`);
      }
    }
  }
  for (const reason of occluded) failures.push(`${label}: ${reason}`);
  return failures;
}

// Every non-Focus view must fit its panels inside the workspace on desktop
// widths. A panel that runs past the workspace, or a heading clipped by its own
// panel, is a cut-off page; long content scrolls inside the panel instead.
export function assessPanels(view, { workspace, panels }) {
  const failures = [];
  const inside = (inner, outer) =>
    inner.left >= outer.left - 0.5 &&
    inner.top >= outer.top - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.bottom <= outer.bottom + 0.5;
  if (!panels.length) failures.push(`${view}: no panels rendered`);
  for (const panel of panels) {
    // A panel inside a scrolling view is reachable by scrolling, not cut off.
    if (!panel.scrolls && !inside(panel.box, workspace))
      failures.push(`${view}: panel "${panel.title}" runs outside the workspace`);
    if (panel.heading && !inside(panel.heading, panel.box))
      failures.push(`${view}: heading "${panel.title}" is clipped by its panel`);
    if (panel.box.bottom - panel.box.top < 48)
      failures.push(
        `${view}: panel "${panel.title}" is squeezed to ${Math.round(panel.box.bottom - panel.box.top)}px`,
      );
  }
  return failures;
}

// Runs in the real browser and only reads geometry.
export function measurePanels() {
  const rectangle = (rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  const content = document.querySelector(".workspace > .panel-content");
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const bounds = content ? rectangle(content.getBoundingClientRect()) : viewport;
  const workspace = {
    left: Math.max(bounds.left, 0),
    top: Math.max(bounds.top, 0),
    right: Math.min(bounds.right, innerWidth),
    bottom: Math.min(bounds.bottom, innerHeight),
  };
  const panels = [...document.querySelectorAll(".view.active .panel, .view.active .settings-card")]
    .filter((panel) => !panel.closest("[hidden]") && getComputedStyle(panel).display !== "none")
    .filter((panel) => !panel.parentElement.closest(".view.active .panel"))
    .filter((panel) => panel.getClientRects().length > 0)
    .map((panel) => {
      const heading = panel.querySelector(".panel-header h2, .panel-header h3, h2, h3");
      let scrolls = false;
      for (
        let node = panel.parentElement;
        node && !node.classList.contains("workspace");
        node = node.parentElement
      ) {
        if (
          /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 0.5
        )
          scrolls = true;
      }
      return {
        title: (heading?.textContent || panel.className).trim().slice(0, 60),
        box: rectangle(panel.getBoundingClientRect()),
        heading: heading ? rectangle(heading.getBoundingClientRect()) : null,
        scrolls,
      };
    });
  return { workspace, panels };
}

// Runs in the real browser. No production styles or element sizes are changed.
export function measureElement(selector, { text = true, hitTest = true } = {}) {
  const element = document.querySelector(selector);
  const result = { label: selector, rects: [], clips: [], hidden: [], occluded: [] };
  if (!element) return result;
  const rectangle = (rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  result.box = rectangle(element.getBoundingClientRect());
  result.content = element.textContent.trim();
  result.clips.push({ label: "viewport", left: 0, top: 0, right: innerWidth, bottom: innerHeight });
  if (text) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      result.rects.push(
        ...Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map(rectangle),
      );
    }
  } else {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) result.rects.push(rectangle(box));
  }
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const label = ancestor.id
      ? `#${ancestor.id}`
      : `${ancestor.tagName.toLowerCase()}.${Array.from(ancestor.classList).join(".")}`;
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
      result.hidden.push(label);
    // Legacy clip is used to visually hide the brand in Focus. It must not
    // remain in effect after navigating to Task Board.
    if (style.display === "contents") continue;
    if (style.clip !== "auto") result.hidden.push(`${label}: clip=${style.clip}`);
    const clipsX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
    const clipsY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
    if (clipsX || clipsY) {
      const rect = ancestor.getBoundingClientRect();
      const left = rect.left + ancestor.clientLeft;
      const top = rect.top + ancestor.clientTop;
      result.clips.push({
        label,
        left: clipsX ? left : -1e9,
        right: clipsX ? left + ancestor.clientWidth : 1e9,
        top: clipsY ? top : -1e9,
        bottom: clipsY ? top + ancestor.clientHeight : 1e9,
      });
    }
  }
  // Pointer hit-testing ignores the decorative bezel. Its even-odd path can
  // still paint over text. Both the shell and bezel are root stacking contexts;
  // wide Focus deliberately raises the shell above the frame.
  const shell = element.closest(".shell");
  if (shell) {
    const shellZ = Number.parseFloat(getComputedStyle(shell).zIndex) || 0;
    for (const path of document.querySelectorAll('.bezel-art path[fill-rule="evenodd"]')) {
      const bezel = path.closest(".bezel-art");
      const bezelStyle = getComputedStyle(bezel);
      const pathStyle = getComputedStyle(path);
      if (
        shellZ >= (Number.parseFloat(bezelStyle.zIndex) || 0) ||
        bezelStyle.display === "none" ||
        bezelStyle.visibility !== "visible" ||
        Number(bezelStyle.opacity) === 0 ||
        pathStyle.display === "none" ||
        pathStyle.visibility !== "visible" ||
        Number(pathStyle.opacity) === 0 ||
        Number(pathStyle.fillOpacity) === 0 ||
        pathStyle.fill === "none"
      )
        continue;
      const matrix = path.getScreenCTM();
      if (!matrix) {
        result.occluded.push("cannot measure visible bezel mask");
        continue;
      }
      const inverse = matrix.inverse();
      const covered = result.rects.some((rect) => {
        const insetX = Math.min(0.5, (rect.right - rect.left) / 4);
        const insetY = Math.min(0.5, (rect.bottom - rect.top) / 4);
        const points = [
          [rect.left + insetX, rect.top + insetY],
          [rect.right - insetX, rect.top + insetY],
          [rect.left + insetX, rect.bottom - insetY],
          [rect.right - insetX, rect.bottom - insetY],
          [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
        ];
        return points.some(([x, y]) =>
          path.isPointInFill(new DOMPoint(x, y).matrixTransform(inverse)),
        );
      });
      if (covered) result.occluded.push("painted over by opaque bezel mask");
    }
  }
  if (hitTest) {
    for (const rect of result.rects) {
      // Three points catch partial overlays as well as entirely covered targets.
      for (const fraction of [0.1, 0.5, 0.9]) {
        const x = rect.left + (rect.right - rect.left) * fraction;
        const y = (rect.top + rect.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === element || element.contains(hit)))
          result.occluded.push(
            `covered or not hit-testable at ${Math.round(x)},${Math.round(y)} by ${hit?.id || hit?.className || "nothing"}`,
          );
      }
    }
  }
  return result;
}

class Cdp {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    let buffer = "";
    child.stdio[4].setEncoding("utf8");
    child.stdio[4].on("data", (data) => {
      buffer += data;
      for (let boundary = buffer.indexOf("\0"); boundary >= 0; boundary = buffer.indexOf("\0")) {
        const message = JSON.parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        } else {
          for (const listener of this.listeners) listener(message);
        }
      }
    });
    const fail = (error) => {
      this.closed = error;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => fail(new Error(`Chromium exited (${code ?? signal})`)));
    child.stdio[3].on("error", fail);
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }
}

async function chromePath() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : (process.env.PATH || "")
        .split(delimiter)
        .flatMap((directory) =>
          ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) =>
            join(directory, name),
          ),
        );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next installed binary */
    }
  }
  throw new Error(
    "Chrome/Chromium is required. Set CHROME_PATH to an installed executable; this gate never skips.",
  );
}

export function responseForRequest(request, html, fixture) {
  if (request.method !== "GET") return null;
  if (request.url === `${origin}/hud`) return { type: "text/html", body: html };
  if (request.url === `${origin}/api/v1/hud/snapshot`)
    return { type: "application/json", body: Buffer.from(JSON.stringify(fixture)) };
  if (request.url === `${origin}/api/v1/voice/catalog`)
    return { type: "application/json", body: Buffer.from(JSON.stringify({ commands: [] })) };
  if (request.url === `${origin}/favicon.ico`)
    return { type: "image/x-icon", body: Buffer.alloc(0) };
  return null;
}

export function browserError(message) {
  if (message.method === "Runtime.exceptionThrown")
    return `Browser exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`;
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
    return `Browser console error: ${message.params.args.map((argument) => argument.description || argument.value || argument.type).join(" ")}`;
  return null;
}

export function scrollTacticalNode(selector, width) {
  if (width >= 1400) {
    document
      .querySelector(selector)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    return;
  }
  // All narrow labels fit in normal flow. scrollIntoView on each child can
  // scroll overflow:hidden ancestors and hide the heading artificially.
  const plate = document.querySelector(".core-side .tac-plate");
  if (!plate) return;
  const rect = plate.getBoundingClientRect();
  window.scrollBy({
    top: rect.top - Math.max(0, (innerHeight - rect.height) / 2),
    left: 0,
    behavior: "instant",
  });
}

export function scrollRightReadout(selector, width) {
  const column = document.querySelector(".col-right");
  const target = document.querySelector(selector);
  if (!column || !target || !column.contains(target)) return null;
  const overflowY = getComputedStyle(column).overflowY;
  const scrollBefore = column.scrollTop;
  if (/^(auto|scroll)$/.test(overflowY)) {
    const bounds = column.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const top = bounds.top + column.clientTop;
    const bottom = top + column.clientHeight;
    if (rect.top < top) column.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) column.scrollTop += rect.bottom - bottom;
  }
  if (width < 1400) {
    const rect = target.getBoundingClientRect();
    window.scrollBy({
      top: rect.top - Math.max(0, (innerHeight - rect.height) / 2),
      left: 0,
      behavior: "instant",
    });
  }
  return {
    selector,
    overflowY,
    clientHeight: column.clientHeight,
    scrollHeight: column.scrollHeight,
    scrollBefore,
    scrollTop: column.scrollTop,
  };
}

async function runScenario(cdp, html, fixtureName, viewport, outputDir) {
  const name = `${viewport.width}x${viewport.height}-${fixtureName}`;
  const fixture = fixtureFor(fixtureName);
  const failures = [];
  const measurements = [];
  const scrollChecks = [];
  const rightColumnScrollChecks = [];
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value;
  };
  let fixtureRequests = 0;
  const listener = (message) => {
    if (message.sessionId !== sessionId) return;
    const error = browserError(message);
    if (error) failures.push(error);
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    const response = responseForRequest(request, html, fixture);
    if (request.url === `${origin}/api/v1/hud/snapshot` && request.method === "GET")
      fixtureRequests += 1;
    const action = response
      ? send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: response.type },
            { name: "Cache-Control", value: "no-store" },
          ],
          body: response.body.toString("base64"),
        })
      : send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    if (!response) failures.push(`Unexpected request blocked: ${request.method} ${request.url}`);
    action.catch((error) => failures.push(`Request interception failed: ${error.message}`));
  };
  cdp.listeners.push(listener);
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await send("Page.navigate", { url: `${origin}/hud` });
    const expectedTitle = fixture.tasks[0]?.title || "Deck cleared.";
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      ready = await evaluate(
        `document.readyState === "complete" && document.querySelector("#status-label")?.textContent === "OPERATIONAL" && document.querySelector("#current-task")?.textContent === ${JSON.stringify(expectedTitle)} && document.querySelectorAll("#tactical-map .tac-node").length === ${fixture.inbox.items.length} && document.querySelector("#tile-inbox")?.textContent === ${JSON.stringify(String(fixture.inbox.items.length))} && document.querySelector("#tile-tasks")?.textContent === ${JSON.stringify(String(fixture.tasks.length))}`,
      );
      if (ready) break;
      await delay(50);
    }
    if (!ready || !fixtureRequests)
      throw new Error("Synthetic snapshot did not render before the deadline");
    await evaluate(
      "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
    );
    const inspect = async (selector, options = {}) => {
      const rightScroll = await evaluate(
        `(${scrollRightReadout.toString()})(${JSON.stringify(selector)}, ${viewport.width})`,
      );
      if (rightScroll) rightColumnScrollChecks.push(rightScroll);
      // The right column scrolls only at its explicit scrollport; narrow page
      // movement must not programmatically scroll hidden plate ancestors.
      if (viewport.width < 1400 && !rightScroll)
        await evaluate(
          `(() => {
            const target = document.querySelector(${JSON.stringify(selector)});
            if (!target) return;
            const rect = target.getBoundingClientRect();
            window.scrollBy({top:rect.top - Math.max(0, (innerHeight - rect.height) / 2),left:0,behavior:"instant"});
          })()`,
        );
      const measurement = await evaluate(
        `(${measureElement.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(options)})`,
      );
      measurements.push(measurement);
      failures.push(...assessVisibility(measurement));
      return measurement;
    };
    const inspectFocus = async () => {
      await inspect("#current-task");
      await inspect(".queue-panel .panel-header h3");
      await inspect("#dev-status");
      await inspect("#data-list .empty");
      for (const selector of [
        "#predictor-state",
        "#waveform-state",
        ".col-left > .plate:last-child .signal-tag",
        "#dial-host",
        "#dial-mem",
        "#dial-store",
        "#dial-link",
      ])
        await inspect(selector);
      for (let index = 1; index <= 3; index += 1)
        await inspect(`.tile-row .tile:nth-child(${index}) span`);
      for (const selector of [
        "#tile-tasks",
        "#tile-reminders",
        "#tile-inbox",
        ".network-plate h2",
        "#network-version",
      ])
        await inspect(selector);
      if (fixtureName === "populated") {
        const scrollSize = await evaluate(`(() => {
          const list = document.querySelector("#tactical-map");
          return { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight };
        })()`);
        scrollChecks.push(scrollSize);
        if (viewport.width >= 1400 && scrollSize.scrollHeight <= scrollSize.clientHeight)
          failures.push("Tactical fixture did not exercise vertical scrolling");
        let maxScrollTop = 0;
        for (let index = 1; index <= 6; index += 1) {
          const selector = `#tactical-map .tac-node:nth-child(${index})`;
          // Scroll once, then measure both labels in one browser evaluation.
          // Calling inspect() separately would scroll the narrow viewport twice
          // and compare rectangles from different coordinate spaces.
          const [node, heading, scrollTop] = await evaluate(`(() => {
            (${scrollTacticalNode.toString()})(${JSON.stringify(selector)}, ${viewport.width});
            const measure = ${measureElement.toString()};
            return [measure(${JSON.stringify(selector)}, {hitTest:false}), measure(".core-side .tac-plate h2", {hitTest:false}), document.querySelector("#tactical-map").scrollTop];
          })()`);
          maxScrollTop = Math.max(maxScrollTop, scrollTop);
          scrollChecks.push({ selector, scrollTop });
          measurements.push(node, heading);
          failures.push(
            ...assessVisibility(node),
            ...assessVisibility(heading),
            ...assessNoOverlap(node, heading),
          );
        }
        if (viewport.width >= 1400 && maxScrollTop === 0)
          failures.push("Tactical labels never scrolled inside their list");
      } else await inspect("#tactical-caption", { hitTest: false });
      if (fixtureName === "populated") {
        await inspect("#current-actions button", { text: false });
        for (let index = 1; index <= 3; index += 1) {
          await inspect(`#focus-queue .priority-row:nth-child(${index}) strong`);
          await inspect(`#focus-queue .priority-row:nth-child(${index}) button`, { text: false });
        }
      } else await inspect("#focus-queue .empty");
    };
    const screenshot = async (suffix) => {
      if (!outputDir) return;
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(outputDir, `${name}-${suffix}.png`), Buffer.from(data, "base64"));
    };
    await inspectFocus();
    await screenshot("focus");
    for (const view of ["board", "focus"]) {
      const selector = `[data-view="${view}"]`;
      const measurement = await inspect(selector, { text: false });
      const box = measurement.box;
      if (!box) throw new Error(`Missing navigation: ${view}`);
      const point = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
      if ((await evaluate("document.body.dataset.consoleView")) !== view)
        throw new Error(`Navigation to ${view} did not activate`);
      if (view === "board") {
        // Every view now shares the Console 02 header: the kicker names the
        // business, and each status chip and nav button must stay hit-testable.
        await inspect(".brand-kicker", { hitTest: false });
        for (const control of await evaluate(
          `[...document.querySelectorAll(".top-actions > [id]")].map((node) => "#" + node.id)`,
        ))
          await inspect(control, { text: false });
        for (const name of [
          "focus",
          "board",
          "reminders",
          "operations",
          "livework",
          "systems",
          "voice",
          "settings",
        ])
          await inspect(`[data-view="${name}"]`, { text: false });
        await screenshot("board");
      } else await inspectFocus();
    }
    if (viewport.width >= 1400) {
      for (const view of [
        "board",
        "reminders",
        "operations",
        "livework",
        "systems",
        "voice",
        "settings",
      ]) {
        await evaluate(`document.querySelector('[data-view="${view}"]').click()`);
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        failures.push(...assessPanels(view, await evaluate(`(${measurePanels.toString()})()`)));
        await screenshot(view);
      }
      await evaluate(`document.querySelector('[data-view="focus"]').click()`);
    }
    const overflowingRightChecks = rightColumnScrollChecks.filter(
      (check) => check.scrollHeight > check.clientHeight + 0.5,
    );
    if (
      overflowingRightChecks.length &&
      !overflowingRightChecks.some((check) => check.scrollTop > 0)
    )
      failures.push("Overflowing right-column readouts never exercised their scrollport");
    const animated = await evaluate(
      'document.querySelectorAll(".core-rings .spin-slow").length > 0 && [...document.querySelectorAll(".core-rings .spin-slow")].some(el => el.getAnimations().some(animation => animation.playState === "running"))',
    );
    if (!animated)
      failures.push("Core animations were not running before reduced-motion was enabled");
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const motion = await evaluate(
      '[...document.querySelectorAll(".core-rings, .core-rings .spin-slow")].map(el => ({animation: getComputedStyle(el).animationName, running: el.getAnimations().some(animation => animation.playState === "running")}))',
    );
    if (!motion.length || motion.some((state) => state.animation !== "none" || state.running))
      failures.push(`Reduced motion did not stop core animations: ${JSON.stringify(motion)}`);
    await screenshot("reduced-motion");
    return {
      name,
      viewport,
      fixture: fixtureName,
      fixtureRequests,
      measurements,
      scrollChecks,
      rightColumnScrollChecks,
      motion,
      failures,
    };
  } catch (error) {
    failures.push(error.message);
    return {
      name,
      viewport,
      fixture: fixtureName,
      fixtureRequests,
      measurements,
      scrollChecks,
      rightColumnScrollChecks,
      failures,
    };
  } finally {
    cdp.listeners = cdp.listeners.filter((candidate) => candidate !== listener);
    await cdp.send("Target.closeTarget", { targetId });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const html = await readFile(options.html);
  if (options.outputDir) await mkdir(options.outputDir, { recursive: true });
  const evidence = {
    checkoutSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    htmlPath: options.html,
    htmlSha256: createHash("sha256").update(html).digest("hex"),
    scenarios: [],
  };
  const profile = await mkdtemp(join(tmpdir(), "jarvis-hud-layout-"));
  let child;
  let stderr = "";
  try {
    const executable = await chromePath();
    // Keep the browser's normal sandbox. A restricted host that cannot launch
    // Chrome is a failed prerequisite, never a reason to report a passing gate.
    child = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-12000);
    });
    const cdp = new Cdp(child);
    evidence.browser = await cdp.send("Browser.getVersion");
    for (const viewport of viewports) {
      for (const fixture of ["empty", "populated"]) {
        const result = await runScenario(cdp, html, fixture, viewport, options.outputDir);
        evidence.scenarios.push(result);
        console.log(`${result.failures.length ? "FAIL" : "PASS"} ${result.name}`);
        for (const failure of result.failures) console.error(`  ${failure}`);
      }
    }
    if (evidence.scenarios.some((scenario) => scenario.failures.length))
      throw new Error("HUD layout regression detected");
    console.log(
      `HUD browser gate passed: 6 scenarios; checkout ${evidence.checkoutSha}; HTML sha256 ${evidence.htmlSha256}`,
    );
  } catch (error) {
    evidence.error = error.message;
    if (stderr) evidence.browserStderr = stderr;
    throw error;
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await stopped;
      clearTimeout(timer);
    }
    if (options.outputDir)
      await writeFile(
        join(options.outputDir, "results.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    // Chromium descendants can briefly retain or recreate profile entries after
    // the browser exits. Retry only the native transient filesystem failures;
    // persistent cleanup errors still fail this gate after a finite budget.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
