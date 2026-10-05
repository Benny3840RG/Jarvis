import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { VOICE_COMMANDS, type VoiceProfile } from "../src/voice/voiceCommands.js";
import { VoiceSessionRegistry } from "../src/voice/voiceSessionRegistry.js";

const html = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
const block = html.match(/\/\/ BEGIN voice-console[\s\S]*?\/\/ END voice-console/)?.[0];
assert.ok(block, "voice-console block must exist");

type Listener = (event: { preventDefault(): void }) => void;

class Element {
  listeners = new Map<string, Listener>();
  children: Element[] = [];
  attributes = new Map<string, string>();
  disabled = false;
  textContent = "";
  value = "";
  hidden = false;

  addEventListener(name: string, listener: Listener) {
    this.listeners.set(name, listener);
  }
  replaceChildren() {
    this.children = [];
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  fire(name: string) {
    if (name === "click" && this.disabled) return;
    const listener = this.listeners.get(name);
    assert.ok(listener, `missing ${name} listener`);
    listener({ preventDefault() {} });
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Request = {
  path: string;
  method: string;
  body: { profile?: VoiceProfile; transcript?: string; isFinal?: boolean; alternatives?: string[] };
};

function harness(options: { microphone?: boolean } = {}) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new Element();
      const openingTag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
      element.disabled = /\bdisabled\b/.test(openingTag);
      elements.set(id, element);
    }
    return element;
  };
  const requests: Request[] = [];
  const spoken: string[] = [];
  const actuations: string[] = [];
  const recognitions: Recognition[] = [];
  const delayedRequests = new Map<string, ReturnType<typeof deferred>>();
  const delayedResponses = new Map<string, ReturnType<typeof deferred>>();
  const failures = new Map<string, number>();
  let now = 1_000;
  let sequence = 0;
  const registry = new VoiceSessionRegistry({
    provider: {
      statusOf: () => "available",
      actuate: async ({ target, commandId }) => {
        actuations.push(commandId);
        return { status: "actuated", target };
      },
    },
    clock: () => now,
    idFactory: () => `s${++sequence}`,
  });

  class Recognition {
    onresult?: (event: unknown) => void;
    onend?: () => void;
    stopCalls = 0;
    abortCalls = 0;
    constructor() {
      recognitions.push(this);
    }
    start() {}
    stop() {
      this.stopCalls += 1;
      // Web Speech stop can flush final buffered audio before ending.
      this.emit("Jarvis confirm");
      this.onend?.();
    }
    abort() {
      this.abortCalls += 1;
      // Even queued callbacks delivered around abort must be ignored.
      this.emit("Jarvis confirm");
      this.onend?.();
    }
    emit(transcript: string, isFinal = true, alternatives: string[] = []) {
      this.onresult?.({
        resultIndex: 0,
        results: [
          Object.assign(
            [{ transcript }, ...alternatives.map((alternative) => ({ transcript: alternative }))],
            { isFinal },
          ),
        ],
      });
    }
  }

  const response = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  async function fetch(url: string, init: { method?: string; body?: string } = {}) {
    const path = url.replace("/api/v1/voice", "");
    const body = (init.body ? JSON.parse(init.body) : {}) as Request["body"];
    const method = init.method ?? "GET";
    requests.push({ path, method, body });
    const delayedRequest = delayedRequests.get(path);
    if (delayedRequest) {
      delayedRequests.delete(path);
      await delayedRequest.promise;
    }
    const failure = failures.get(path);
    if (failure) {
      failures.delete(path);
      return response({ status: failure, title: "Voice service error" }, failure);
    }
    let reply;
    if (path === "/catalog") {
      reply = response({ commands: VOICE_COMMANDS });
    } else if (path === "/sessions") {
      assert.ok(body.profile);
      const created = registry.create(body.profile);
      reply = response({ sessionId: created.id, profile: created.profile }, 201);
    } else {
      const [, , id, operation] = path.split("/");
      if (method === "DELETE") {
        reply = registry.end(id) ? response(null, 204) : response({ status: 404 }, 404);
      } else {
        const session = registry.get(id);
        if (!session) {
          reply = response({ status: 404, title: "Voice session not found" }, 404);
        } else if (operation === "profile") {
          assert.ok(body.profile);
          session.setProfile(body.profile, now);
          reply = response({ sessionId: id, profile: session.profile, pending: null });
        } else {
          assert.equal(operation, "utterances");
          assert.equal(typeof body.transcript, "string");
          const dispatch = await session.handle({
            transcript: body.transcript!,
            isFinal: body.isFinal === true,
            alternatives: body.alternatives,
            now,
          });
          reply = response({ dispatch, pending: session.pending() ?? null });
        }
      }
    }
    const delayedResponse = delayedResponses.get(path);
    if (delayedResponse) {
      delayedResponses.delete(path);
      await delayedResponse.promise;
    }
    return reply;
  }

  const window = {
    ...(options.microphone === false ? {} : { SpeechRecognition: Recognition }),
    speechSynthesis: {
      cancel() {},
      speak(utterance: { text: string }) {
        spoken.push(utterance.text);
      },
    },
  };
  new Function(
    "window",
    "document",
    "fetch",
    "SpeechSynthesisUtterance",
    `${block}\nsetupVoiceConsole();`,
  )(
    window,
    { getElementById: get, createElement: () => new Element() },
    fetch,
    class {
      constructor(readonly text: string) {}
    },
  );

  return {
    get,
    requests,
    registry,
    spoken,
    actuations,
    recognitions,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    profile(profile: VoiceProfile) {
      const button = get("voice-profiles").children.find((child) => child.textContent === profile);
      assert.ok(button);
      button.fire("click");
    },
    type(value: string) {
      get("voice-text").value = value;
      get("voice-typed").fire("submit");
    },
    enable() {
      get("voice-enable").fire("click");
      return recognitions.at(-1)!;
    },
    stop() {
      get("voice-stop").fire("click");
    },
    pause(path: string, phase: "request" | "response" = "request") {
      const gate = deferred();
      (phase === "request" ? delayedRequests : delayedResponses).set(path, gate);
      return gate.release;
    },
    fail(path: string, status: number) {
      failures.set(path, status);
    },
    utterances() {
      return requests.filter((request) => request.path.endsWith("/utterances"));
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function armCrawler(h: ReturnType<typeof harness>) {
  h.profile("crawler");
  await flush();
  h.type("crawler halt");
  await flush();
  assert.equal(h.get("voice-pending").hidden, false);
}

describe("voice HUD lifecycle (actual setupVoiceConsole and real session registry)", () => {
  it("requires explicit microphone enable and preserves typed fallback", async () => {
    const h = harness({ microphone: false });
    await flush();
    assert.equal(h.recognitions.length, 0);
    assert.equal(h.get("voice-enable").disabled, true);
    h.type("any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
  });

  it("preserves wake-word, final-only and alternatives checks in the actual event wiring", async () => {
    const h = harness();
    await armCrawler(h);
    const recognition = h.enable();
    const before = h.utterances().length;
    recognition.emit("confirm");
    recognition.emit("Jarvis confirm", false);
    await flush();
    assert.equal(h.utterances().length, before);
    recognition.emit("Jarvis confirm", true, ["Jarvis cancel"]);
    await flush();
    assert.deepEqual(h.utterances().at(-1)?.body.alternatives, ["cancel"]);
    assert.deepEqual(h.actuations, []);
    assert.match(h.get("voice-result").textContent, /ambiguous/i);
    assert.equal(h.get("voice-pending").hidden, true);
  });

  it("aborts Stop without flushing buffered confirmation or restarting speech", async () => {
    const h = harness();
    await armCrawler(h);
    const recognition = h.enable();
    const commandsBefore = h.utterances().length;
    const spokenBefore = h.spoken.length;
    h.stop();
    recognition.emit("Jarvis confirm");
    await flush();
    assert.equal(recognition.abortCalls, 1);
    assert.equal(recognition.stopCalls, 0);
    assert.equal(h.utterances().length, commandsBefore);
    assert.deepEqual(h.actuations, []);
    assert.equal(h.spoken.length, spokenBefore);
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(h.get("voice-enable").disabled, false);
    h.type("confirm");
    await flush();
    assert.deepEqual(h.actuations, [], "Stop must not retain a consumable old confirmation");
  });

  it("ignores old recognition callbacks after an explicit restart", async () => {
    const h = harness();
    const oldRecognition = h.enable();
    h.stop();
    const currentRecognition = h.enable();
    const before = h.utterances().length;
    oldRecognition.emit("Jarvis any unpaid invoices");
    oldRecognition.onend?.();
    await flush();
    assert.equal(h.utterances().length, before);
    assert.equal(h.get("voice-enable").disabled, true);
    currentRecognition.emit("Jarvis any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
  });

  it("drops Stop-invalidated session creation before sending the queued command", async () => {
    const h = harness();
    const release = h.pause("/sessions");
    h.type("any unpaid invoices");
    await flush();
    h.stop();
    release();
    await flush();
    assert.equal(h.utterances().length, 0);
    assert.equal(h.spoken.length, 0);
    assert.equal(h.registry.size(), 0, "retire a session created by an obsolete request");
  });

  it("does not render or speak an in-flight reply after Stop", async () => {
    const h = harness();
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("any unpaid invoices");
    await flush();
    h.stop();
    const afterStop = h.get("voice-result").textContent;
    release();
    await flush();
    assert.equal(h.get("voice-result").textContent, afterStop);
    assert.equal(h.spoken.length, 0);
    h.type("any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
  });

  it("suppresses a late actuation reply without claiming Stop undid a sent operation", async () => {
    const h = harness();
    h.profile("crawler");
    await flush();
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("crawler lights on");
    await flush();
    assert.deepEqual(h.actuations, ["crawler.lights-on"]);
    h.stop();
    release();
    await flush();
    assert.deepEqual(h.actuations, ["crawler.lights-on"]);
    assert.equal(h.spoken.length, 0);
    assert.equal(h.registry.size(), 0);
    assert.match(h.get("voice-result").textContent, /stopped/i);
  });

  it("clears pending immediately and pauses dispatch until profile acknowledgement", async () => {
    const h = harness();
    await armCrawler(h);
    const release = h.pause("/sessions/s1/profile");
    h.profile("client");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(h.get("voice-profile-label").textContent, "CRAWLER");
    h.type("confirm");
    await flush();
    assert.deepEqual(h.actuations, []);
    release();
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(h.utterances().length, 1, "do not replay commands received during transition");
    h.type("confirm");
    await flush();
    assert.deepEqual(h.actuations, []);
  });

  it("blocks an HTTP-failed profile switch from consuming the old pending command", async () => {
    const h = harness();
    await armCrawler(h);
    h.fail("/sessions/s1/profile", 503);
    h.profile("client");
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CRAWLER");
    assert.match(h.get("voice-result").textContent, /profile.*failed|profile.*unavailable/i);
    h.type("confirm");
    await flush();
    assert.deepEqual(h.actuations, []);
    assert.equal(h.utterances().length, 1);
    h.profile("client");
    await flush();
    h.type("any unpaid invoices");
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
  });

  it("discards an old session created while a new profile is being selected", async () => {
    const h = harness();
    const release = h.pause("/sessions");
    h.type("any unpaid invoices");
    await flush();
    h.profile("crawler");
    await flush();
    release();
    await flush();
    h.type("crawler status");
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CRAWLER");
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
    assert.equal(h.utterances().length, 1, "obsolete command must not reach either session");
    const id = h.utterances()[0].path.split("/")[2];
    assert.equal(h.registry.get(id)?.profile, "crawler");
    assert.equal(h.registry.size(), 1);
  });

  it("ignores a stale profile reply after a newer profile has been acknowledged", async () => {
    const h = harness();
    await armCrawler(h);
    const release = h.pause("/sessions/s1/profile");
    h.profile("workshop");
    await flush();
    h.profile("client");
    await flush();
    release();
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    h.type("any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
    assert.equal(h.registry.size(), 1);
  });

  it("does not restore old pending UI or TTS after changing profiles", async () => {
    const h = harness();
    h.profile("crawler");
    await flush();
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("crawler halt");
    await flush();
    h.profile("client");
    await flush();
    const spokenBefore = h.spoken.length;
    release();
    await flush();
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(h.spoken.length, spokenBefore);
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
  });

  it("invalidates an expired session and waits for a fresh command without replay", async () => {
    const h = harness();
    await armCrawler(h);
    h.advance(31 * 60_000);
    h.type("confirm");
    await flush();
    assert.match(h.get("voice-result").textContent, /expired|no longer available/i);
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(h.requests.filter((request) => request.path === "/sessions").length, 1);
    assert.equal(
      h.utterances().filter((request) => request.body.transcript === "confirm").length,
      1,
    );
    h.type("crawler status");
    await flush();
    assert.equal(h.requests.filter((request) => request.path === "/sessions").length, 2);
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
    assert.deepEqual(h.actuations, []);
  });

  it("checks failed session creation and never dispatches to an undefined session", async () => {
    const h = harness();
    h.fail("/sessions", 503);
    h.type("any unpaid invoices");
    await flush();
    assert.equal(h.utterances().length, 0);
    assert.match(h.get("voice-result").textContent, /unreachable|unavailable|failed/i);
    h.type("any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
  });

  it("serializes commands so delayed replies cannot overwrite newer pending state", async () => {
    const h = harness();
    await armCrawler(h);
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("crawler status");
    h.type("crawler halt");
    await flush();
    assert.equal(h.utterances().length, 2, "the newer command waits for the current reply");
    release();
    await flush();
    assert.equal(h.utterances().length, 3);
    assert.equal(h.get("voice-pending").hidden, false);
    assert.match(h.get("voice-result").textContent, /awaiting/i);
  });

  it("waits for a sent utterance before reusing its session for another profile", async () => {
    const h = harness();
    await armCrawler(h);
    const release = h.pause("/sessions/s1/utterances");
    h.type("confirm");
    await flush();
    h.profile("client");
    await flush();
    assert.equal(h.requests.filter((request) => request.path.endsWith("/profile")).length, 0);
    assert.equal(h.get("voice-profile-label").textContent, "CRAWLER");
    release();
    await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.equal(
      h.actuations.length,
      1,
      "an already-sent confirmation cannot be undone by the HUD",
    );
  });

  it("discards queued old-profile commands instead of replaying after acknowledgement", async () => {
    const h = harness();
    await armCrawler(h);
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("crawler halt");
    await flush();
    h.type("confirm");
    h.profile("client");
    await flush();
    release();
    await flush();
    assert.equal(
      h.utterances().filter((request) => request.body.transcript === "confirm").length,
      0,
    );
    assert.deepEqual(h.actuations, []);
    assert.equal(h.get("voice-pending").hidden, true);
  });

  it("shares initial session creation across simultaneous fresh commands", async () => {
    const h = harness();
    const release = h.pause("/sessions");
    h.type("any unpaid invoices");
    h.type("draft a quote");
    await flush();
    assert.equal(h.requests.filter((request) => request.path === "/sessions").length, 1);
    release();
    await flush();
    assert.equal(h.utterances().length, 2);
    assert.equal(new Set(h.utterances().map((request) => request.path)).size, 1);
  });
});
