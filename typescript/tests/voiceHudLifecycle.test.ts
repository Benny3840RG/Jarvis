import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { VOICE_COMMANDS, type VoiceProfile } from "../src/voice/voiceCommands.js";
import { voiceUtteranceForSession } from "../src/voice/voiceSafeWrite.js";
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
  body: {
    profile?: VoiceProfile;
    transcript?: string;
    isFinal?: boolean;
    alternatives?: string[];
    heardTranscript?: string;
  };
};

function harness(
  options: {
    microphone?: boolean;
    switchWaitMs?: number;
    synthesis?: boolean;
    noVoices?: boolean;
    speechThrows?: boolean;
    /** Treat every recognition session as long-lived (no rapid-end guard). */
    longSessions?: boolean;
  } = {},
) {
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
  const speechUtterances: {
    text: string;
    onstart?: () => void;
    onend?: () => void;
    onerror?: () => void;
  }[] = [];
  const speechCancels = { count: 0 };
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
    // Same as the maintained HTTP app: inference only ever arms a confirmation.
    interpretNaturalLanguage: true,
  });

  class Recognition {
    onresult?: (event: unknown) => void;
    onend?: () => void;
    onerror?: (event: { error: string }) => void;
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
          // Mirror the voice controller: the server, not the HUD, decides wake authority.
          const prepared = voiceUtteranceForSession({
            transcript: body.transcript!,
            ...(body.heardTranscript === undefined
              ? {}
              : { heardTranscript: body.heardTranscript }),
            ...(body.alternatives ? { alternatives: body.alternatives } : {}),
          });
          const dispatch = await session.handle({
            transcript: prepared.transcript,
            isFinal: body.isFinal === true,
            wakeAuthorized: prepared.wakeAuthorized,
            ...(prepared.alternatives ? { alternatives: prepared.alternatives } : {}),
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
    SpeechSynthesisUtterance: class {
      constructor(readonly text: string) {}
    },
    ...(options.synthesis === false
      ? {}
      : {
          speechSynthesis: {
            cancel() {
              speechCancels.count += 1;
            },
            getVoices() {
              return options.noVoices ? [] : [{}];
            },
            speak(utterance: {
              text: string;
              onstart?: () => void;
              onend?: () => void;
              onerror?: () => void;
            }) {
              if (options.speechThrows) throw new Error("speech failure");
              spoken.push(utterance.text);
              speechUtterances.push(utterance);
            },
          },
        }),
  };
  new Function(
    "window",
    "document",
    "fetch",
    "SpeechSynthesisUtterance",
    `${(options.switchWaitMs === undefined
      ? block!
      : block!.replace(
          "var PROFILE_SWITCH_WAIT_MS = 10000;",
          `var PROFILE_SWITCH_WAIT_MS = ${options.switchWaitMs};`,
        )
    ).replace(
      "var RECOGNITION_SHORT_END_MS = 2000;",
      `var RECOGNITION_SHORT_END_MS = ${options.longSessions ? 0 : 2000};`,
    )}\nsetupVoiceConsole();`,
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
    speechUtterances,
    speechCancels,
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

const AMBIGUOUS_REQUEST = "Jarvis crawler forward and turn crawler lights on";
const CLARIFICATION_PROMPT =
  "Ambiguous — nothing was done. Did you mean: 1. Drive the crawler forward; " +
  "2. Turn the crawler inspection lights on? Reply once with “Jarvis” and your choice, " +
  "or repeat the full command.";
const GENERIC_AMBIGUOUS = "Ambiguous — ignored for safety.";

async function offerClarification(h: ReturnType<typeof harness>) {
  h.profile("crawler");
  await flush();
  h.type(AMBIGUOUS_REQUEST);
  await flush();
  assert.equal(h.get("voice-result").textContent, CLARIFICATION_PROMPT);
}

const sessionCreations = (h: ReturnType<typeof harness>) =>
  h.requests.filter((request) => request.path === "/sessions").length;

type Describe = (
  dispatch: unknown,
  catalog?: unknown,
  profile?: unknown,
) => { label: string; tone: string };
const describeVoiceDispatch = new Function(
  `"use strict"; ${block}\n return describeVoiceDispatch;`,
)() as Describe;

describe("voice HUD clarification prompt (#567)", () => {
  it("displays and speaks only the returned candidates and keeps the session for one reply", async () => {
    const h = harness();
    await offerClarification(h);
    assert.equal(h.spoken.at(-1), CLARIFICATION_PROMPT);
    assert.equal(h.get("voice-result").attributes.get("data-tone"), "warn");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
    const creations = sessionCreations(h);
    const sent = h.utterances().length;

    h.type("Jarvis the second one");
    await flush();
    assert.equal(sessionCreations(h), creations, "the reply reuses the same server session");
    assert.equal(h.utterances().length, sent + 1, "exactly one reply request, no local dispatch");
    assert.equal(h.utterances().at(-1)?.path, h.utterances().at(-2)?.path);
    assert.equal(h.get("voice-result").textContent, "Awaiting spoken “confirm”.");
    assert.match(h.get("voice-pending").textContent, /Turn the crawler inspection lights on/);
    assert.deepEqual(h.actuations, [], "a clarified choice still waits for server confirmation");

    h.type("Jarvis confirm");
    await flush();
    assert.deepEqual(h.actuations, ["crawler.lights-on"]);
    assert.equal(h.get("voice-pending").hidden, true);
  });

  it("offers the choice once: a second ordinal after the reply does nothing", async () => {
    const h = harness();
    await offerClarification(h);
    h.type("Jarvis what");
    await flush();
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    h.type("Jarvis the second one");
    await flush();
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
  });

  it("keeps interim speech silent and resolves only on a final spoken reply", async () => {
    const h = harness();
    h.profile("crawler");
    await flush();
    const recognition = h.enable();
    recognition.emit(AMBIGUOUS_REQUEST, false);
    await flush();
    assert.equal(h.utterances().length, 0);
    assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
    recognition.emit(AMBIGUOUS_REQUEST);
    await flush();
    assert.equal(h.get("voice-result").textContent, CLARIFICATION_PROMPT);
    assert.equal(h.spoken.at(-1), CLARIFICATION_PROMPT);

    recognition.emit("Jarvis the second one", false);
    recognition.emit("the second one");
    await flush();
    assert.equal(h.utterances().length, 1, "interim and wake-less replies never dispatch");
    assert.equal(h.get("voice-result").textContent, CLARIFICATION_PROMPT);

    recognition.emit("Jarvis the second one");
    await flush();
    assert.equal(h.utterances().at(-1)?.body.transcript, "the second one");
    assert.equal(h.utterances().at(-1)?.body.heardTranscript, "jarvis the second one");
    assert.equal(h.get("voice-result").textContent, "Awaiting spoken “confirm”.");
    assert.match(h.get("voice-pending").textContent, /Turn the crawler inspection lights on/);
    assert.deepEqual(h.actuations, []);
  });

  it("leaves nothing pending when a recogniser alternative disagrees with the reply", async () => {
    const h = harness();
    await offerClarification(h);
    const recognition = h.enable();
    recognition.emit("Jarvis the second one", true, ["Jarvis the first one"]);
    await flush();
    assert.deepEqual(h.utterances().at(-1)?.body.alternatives, ["the first one"]);
    assert.equal(h.get("voice-pending").hidden, true);
    recognition.emit("Jarvis the second one");
    await flush();
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
  });

  it("drops the prompt and the offer on Stop", async () => {
    const h = harness();
    await offerClarification(h);
    const creations = sessionCreations(h);
    h.stop();
    assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
    h.type("Jarvis the second one");
    await flush();
    assert.equal(sessionCreations(h), creations + 1, "Stop retired the offering session");
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
  });

  it("drops the prompt and the offer on a profile change", async () => {
    const h = harness();
    await offerClarification(h);
    h.profile("workshop");
    assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
    await flush();
    h.profile("crawler");
    await flush();
    assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
    h.type("Jarvis the second one");
    await flush();
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
  });

  it("drops the prompt when the session fails and never replays the reply", async () => {
    const h = harness();
    await offerClarification(h);
    h.advance(31 * 60_000);
    h.type("Jarvis the second one");
    await flush();
    assert.match(h.get("voice-result").textContent, /expired|no longer available/i);
    assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
    assert.equal(
      h.utterances().filter((request) => request.body.transcript === "Jarvis the second one")
        .length,
      1,
    );
    h.type("Jarvis the second one");
    await flush();
    assert.equal(h.get("voice-result").textContent, "Command not recognised.");
    assert.equal(h.get("voice-pending").hidden, true);
    assert.deepEqual(h.actuations, []);
  });

  for (const failure of [
    { status: 404, notice: /expired or is no longer available/ },
    { status: 503, notice: /Voice service unavailable/ },
  ]) {
    it(`stops the spoken prompt when the reply request fails (${failure.status})`, async () => {
      const h = harness();
      await offerClarification(h);
      const prompt = h.speechUtterances.at(-1)!;
      assert.equal(prompt.text, CLARIFICATION_PROMPT);
      prompt.onstart?.();
      assert.match(h.get("voice-output-status").textContent, /started/i);
      const cancels = h.speechCancels.count;
      const spoken = h.spoken.length;
      const creations = sessionCreations(h);
      const sent = h.utterances().length;

      h.fail(h.utterances().at(-1)!.path, failure.status);
      h.type("Jarvis the second one");
      await flush();
      assert.equal(h.speechCancels.count, cancels + 1, "the active prompt speech is cancelled");
      assert.equal(h.spoken.length, spoken, "the failure notice is not spoken");
      assert.match(h.get("voice-result").textContent, failure.notice);
      assert.doesNotMatch(h.get("voice-result").textContent, /Did you mean/);
      assert.equal(h.get("voice-pending").hidden, true);
      const stopped = h.get("voice-output-status").textContent;
      assert.match(stopped, /stopped/i);

      const notice = h.get("voice-result").textContent;
      prompt.onstart?.();
      prompt.onend?.();
      prompt.onerror?.();
      assert.equal(h.get("voice-output-status").textContent, stopped);
      assert.equal(h.get("voice-result").textContent, notice);
      assert.equal(h.utterances().length, sent + 1, "the failed reply is never retried");
      assert.equal(sessionCreations(h), creations, "no session is created until a fresh command");
      assert.deepEqual(h.actuations, []);

      h.type("Jarvis the second one");
      await flush();
      assert.equal(sessionCreations(h), creations + 1);
      assert.equal(h.get("voice-result").textContent, "Command not recognised.");
      assert.equal(h.get("voice-pending").hidden, true);
      assert.deepEqual(h.actuations, []);
    });
  }

  it("replaces the prompt with an ordinary non-ambiguous result", async () => {
    const h = harness();
    await offerClarification(h);
    h.type("Jarvis crawler status");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
    assert.equal(h.get("voice-pending").hidden, true);
  });

  it("does not invite a choice for control conflicts and falls back to plain ids", () => {
    assert.deepEqual(
      describeVoiceDispatch(
        { decision: "ambiguous", candidates: ["control.cancel", "control.confirm"] },
        VOICE_COMMANDS,
        "crawler",
      ),
      {
        label:
          "Ambiguous — nothing was done. Conflicting: control.cancel; control.confirm. " +
          "Repeat the full command.",
        tone: "warn",
      },
    );
    // No catalog, or a catalog entry from another profile, never lends its summary.
    for (const catalog of [undefined, [], VOICE_COMMANDS]) {
      assert.equal(
        describeVoiceDispatch(
          { decision: "ambiguous", candidates: ["crawler.forward", "crawler.lights-on"] },
          catalog,
          "workshop",
        ).label,
        "Ambiguous — nothing was done. Conflicting: crawler.forward; crawler.lights-on. " +
          "Repeat the full command.",
      );
    }
  });

  it("formats deterministically within fixed bounds", () => {
    const single = describeVoiceDispatch(
      { decision: "ambiguous", candidates: ["crawler.forward"] },
      VOICE_COMMANDS,
      "crawler",
    );
    assert.equal(
      single.label,
      "Ambiguous — nothing was done. Did you mean: Drive the crawler forward? " +
        "Reply once with “Jarvis” and your choice, or repeat the full command.",
    );
    const ids = VOICE_COMMANDS.filter((command) => command.profile === "crawler").map(
      (command) => command.id,
    );
    assert.ok(ids.length > 4);
    const many = describeVoiceDispatch(
      { decision: "ambiguous", candidates: ids },
      VOICE_COMMANDS,
      "crawler",
    ).label;
    assert.match(many, /4\. [^;]+; and \d+ more\? Reply once/);
    assert.doesNotMatch(many, /5\. /);
    assert.equal(
      many,
      describeVoiceDispatch({ decision: "ambiguous", candidates: ids }, VOICE_COMMANDS, "crawler")
        .label,
    );
    const long = describeVoiceDispatch(
      { decision: "ambiguous", candidates: ["crawler.forward", "crawler.stop"] },
      [
        { id: "crawler.forward", profile: "crawler", summary: `  spaced\n out ${"x".repeat(500)}` },
        { id: "crawler.stop", profile: "crawler", summary: "<img src=x onerror=alert(1)>" },
      ],
      "crawler",
    ).label;
    assert.ok(long.length < 400, `bounded label, got ${long.length}`);
    assert.match(long, /1\. spaced out x+…; 2\. <img src=x onerror=alert\(1\)>\?/);
  });

  it("fails closed to the generic label for malformed candidate lists", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "crawler.forward",
      [],
      [42, "crawler.forward"],
      ["crawler.forward", "crawler.forward"],
      ["<script>alert(1)</script>", "crawler.forward"],
      ["crawler.forward", "Crawler Forward"],
      ["crawler.forward", "x".repeat(65)],
      Array.from({ length: 65 }, (_, index) => `crawler.c${index}`),
    ];
    for (const candidates of malformed) {
      assert.deepEqual(
        describeVoiceDispatch({ decision: "ambiguous", candidates }, VOICE_COMMANDS, "crawler"),
        { label: GENERIC_AMBIGUOUS, tone: "warn" },
        JSON.stringify(candidates)?.slice(0, 80),
      );
    }
    assert.deepEqual(describeVoiceDispatch({ decision: "ambiguous" }), {
      label: GENERIC_AMBIGUOUS,
      tone: "warn",
    });
  });

  it("accepts every catalog id and renders through textContent only", () => {
    for (const command of VOICE_COMMANDS) {
      assert.notEqual(
        describeVoiceDispatch(
          { decision: "ambiguous", candidates: [command.id] },
          VOICE_COMMANDS,
          command.profile,
        ).label,
        GENERIC_AMBIGUOUS,
        command.id,
      );
    }
    assert.doesNotMatch(block!, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("voice HUD lifecycle (actual setupVoiceConsole and real session registry)", () => {
  it("tests local speech only on request and reports browser events without claiming audibility", async () => {
    const h = harness();
    await flush();
    assert.equal(h.spoken.length, 0);
    h.get("voice-test-output").fire("click");
    assert.deepEqual(h.spoken, ["Speech output test."]);
    assert.equal(h.recognitions.length, 0);
    assert.equal(h.utterances().length, 0);
    h.speechUtterances[0].onstart?.();
    assert.match(h.get("voice-output-status").textContent, /started/i);
    h.speechUtterances[0].onend?.();
    assert.match(h.get("voice-output-status").textContent, /cannot confirm.*heard/i);
    h.get("voice-test-output").fire("click");
    h.speechUtterances[1].onerror?.();
    assert.match(h.get("voice-output-status").textContent, /failed/i);
    assert.equal(h.actuations.length, 0);
  });

  it("does not dispatch the spoken test phrase when the microphone hears it", async () => {
    const h = harness();
    const recognition = h.enable();
    h.get("voice-test-output").fire("click");
    recognition.emit(h.spoken[0]);
    await flush();
    assert.deepEqual(h.spoken, ["Speech output test."]);
    assert.equal(h.utterances().length, 0);
    assert.equal(h.registry.size(), 0);
    assert.deepEqual(h.actuations, []);
  });

  it("preserves idle and unavailable speech status on Stop and profile change", async () => {
    const idle = harness();
    const initial = idle.get("voice-output-status").textContent;
    idle.profile("crawler");
    await flush();
    assert.equal(idle.get("voice-output-status").textContent, initial);
    idle.stop();
    assert.equal(idle.get("voice-output-status").textContent, initial);
    const unavailable = harness({ synthesis: false });
    unavailable.get("voice-test-output").fire("click");
    const status = unavailable.get("voice-output-status").textContent;
    unavailable.stop();
    assert.equal(unavailable.get("voice-output-status").textContent, status);
    unavailable.profile("crawler");
    await flush();
    assert.equal(unavailable.get("voice-output-status").textContent, status);
    const finished = harness();
    finished.get("voice-test-output").fire("click");
    finished.speechUtterances[0].onend?.();
    const completed = finished.get("voice-output-status").textContent;
    finished.stop();
    assert.equal(finished.get("voice-output-status").textContent, completed);
  });

  it("ignores callbacks from superseded and cancelled utterances", async () => {
    const h = harness();
    h.get("voice-test-output").fire("click");
    h.get("voice-test-output").fire("click");
    const requested = h.get("voice-output-status").textContent;
    h.speechUtterances[0].onstart?.();
    h.speechUtterances[0].onend?.();
    h.speechUtterances[0].onerror?.();
    assert.equal(h.get("voice-output-status").textContent, requested);
    h.profile("crawler");
    const stopped = h.get("voice-output-status").textContent;
    h.speechUtterances[1].onstart?.();
    h.speechUtterances[1].onend?.();
    h.speechUtterances[1].onerror?.();
    assert.match(stopped, /stopped/i);
    assert.equal(h.get("voice-output-status").textContent, stopped);
    await flush();
  });

  it("reports unavailable speech and ignores late callbacks after Stop", async () => {
    const unavailable = harness({ synthesis: false });
    await flush();
    unavailable.get("voice-test-output").fire("click");
    assert.match(unavailable.get("voice-output-status").textContent, /unavailable/i);
    const h = harness();
    h.get("voice-test-output").fire("click");
    h.stop();
    h.speechUtterances[0].onerror?.();
    assert.match(h.get("voice-output-status").textContent, /stopped/i);
  });

  it("reports empty voice lists, synchronous failures, and errors in normal responses", async () => {
    const empty = harness({ noVoices: true });
    empty.get("voice-test-output").fire("click");
    assert.match(empty.get("voice-output-status").textContent, /no voices currently listed/i);
    const throwing = harness({ speechThrows: true });
    throwing.get("voice-test-output").fire("click");
    assert.match(throwing.get("voice-output-status").textContent, /failed/i);
    const h = harness();
    h.type("unknown command");
    await flush();
    h.speechUtterances[0].onerror?.();
    assert.match(h.get("voice-output-status").textContent, /failed/i);
    assert.match(h.get("voice-result").textContent, /not recognised/i);
  });

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

  for (const status of [503, 404]) {
    it(`finishes a profile switch when the queued command before it fails (${status})`, async () => {
      // Review finding on #759: a failed command queued ahead of a switch was
      // said to advance the session generation and leave the profile paused.
      // Its failure handler checks the generation first, so it must not.
      const h = harness();
      await armCrawler(h);
      const release = h.pause("/sessions/s1/utterances");
      h.fail("/sessions/s1/utterances", status);
      h.type("crawler status");
      await flush();
      h.profile("client");
      await flush();
      assert.match(h.get("voice-result").textContent, /Changing voice profile/);

      release();
      for (let index = 0; index < 5; index += 1) await flush();

      assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
      assert.match(h.get("voice-result").textContent, /Voice profile ready: CLIENT/);
      h.type("any unpaid invoices");
      await flush();
      assert.equal(
        h.get("voice-result").textContent,
        "Query unavailable — no data provider connected.",
      );
    });
  }

  it("does not stay paused when the command queued before a switch never answers", async () => {
    const h = harness({ switchWaitMs: 20 });
    await armCrawler(h);
    const releaseHung = h.pause("/sessions/s1/utterances");
    h.type("crawler status");
    await flush();
    h.profile("client");
    await flush();
    assert.match(h.get("voice-result").textContent, /Changing voice profile/);

    await new Promise((resolve) => setTimeout(resolve, 40));
    for (let index = 0; index < 5; index += 1) await flush();

    // The hung session is retired and the switch completes on a fresh one,
    // so the stale utterance can never land in the new profile.
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    assert.match(h.get("voice-result").textContent, /Voice profile ready: CLIENT/);
    assert.equal(h.registry.get("s1"), undefined);
    assert.equal(h.registry.get("s2")?.profile, "client");

    releaseHung();
    for (let index = 0; index < 5; index += 1) await flush();
    assert.equal(h.get("voice-profile-label").textContent, "CLIENT");
    h.type("any unpaid invoices");
    await flush();
    assert.equal(
      h.get("voice-result").textContent,
      "Query unavailable — no data provider connected.",
    );
    assert.deepEqual(h.actuations, []);
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
    const baseline = h.utterances().length;
    assert.equal(baseline, 1, "arming the crawler sends one setup utterance");
    const release = h.pause("/sessions/s1/utterances", "response");
    h.type("crawler status");
    h.type("crawler halt");
    await flush();
    assert.deepEqual(
      h
        .utterances()
        .slice(baseline)
        .map((request) => request.body.transcript),
      ["crawler status"],
      "the newer command waits for the current reply",
    );
    release();
    await flush();
    assert.deepEqual(
      h
        .utterances()
        .slice(baseline)
        .map((request) => request.body.transcript),
      ["crawler status", "crawler halt"],
    );
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

  it("keeps listening when the browser ends a recognition session on its own", async () => {
    const h = harness({ longSessions: true });
    let recognition = h.enable();
    for (let round = 0; round < 6; round += 1) {
      recognition.onerror?.({ error: round % 2 ? "no-speech" : "network" });
      recognition.onend?.();
      assert.equal(h.recognitions.length, round + 2, "a fresh session replaces the ended one");
      assert.equal(h.get("voice-enable").disabled, true, "the microphone still counts as on");
      recognition = h.recognitions.at(-1)!;
    }
    recognition.emit("Jarvis any unpaid invoices");
    await flush();
    assert.equal(h.utterances().length, 1, "the resumed session dispatches normally");
    h.recognitions[0].emit("Jarvis any unpaid invoices");
    await flush();
    assert.equal(h.utterances().length, 1, "an ended session can no longer dispatch");
  });

  it("does not resume listening after Stop", () => {
    const h = harness({ longSessions: true });
    const recognition = h.enable();
    h.stop();
    recognition.onend?.();
    assert.equal(h.recognitions.length, 1);
    assert.equal(h.get("voice-enable").disabled, false);
  });

  it("does not resume listening after a browser error that must not be retried", () => {
    const notices: Record<string, RegExp> = {
      "not-allowed": /refused microphone access.*\(not-allowed\)/,
      "service-not-allowed": /refused the speech recognition service.*\(service-not-allowed\)/,
      "audio-capture": /no microphone audio could be captured.*\(audio-capture\)/,
      "language-not-supported": /does not support speech recognition.*\(language-not-supported\)/,
      // The operator cancelling input in browser UI must not be overridden, however
      // long the session had been running.
      aborted: /speech input was cancelled in the browser \(aborted\)/,
    };
    for (const [error, notice] of Object.entries(notices)) {
      const h = harness({ longSessions: true });
      const recognition = h.enable();
      recognition.onerror?.({ error });
      recognition.onend?.();
      assert.equal(h.recognitions.length, 1, error);
      assert.equal(h.get("voice-enable").disabled, false, error);
      assert.match(h.get("voice-result").textContent, notice, error);
    }
  });

  it("gives up without inventing a reason when sessions end with no error code", () => {
    const h = harness();
    h.enable();
    for (let round = 0; round < 3; round += 1) h.recognitions.at(-1)!.onend?.();
    assert.equal(h.recognitions.length, 3);
    assert.equal(h.get("voice-enable").disabled, false);
    assert.equal(
      h.get("voice-result").textContent,
      "Microphone stopped: speech recognition keeps ending. Check the connection, then enable the microphone again.",
    );
  });

  it("gives up with a notice when recognition keeps ending straight away", () => {
    const h = harness();
    h.enable();
    for (let round = 0; round < 2; round += 1) {
      const current = h.recognitions.at(-1)!;
      current.onerror?.({ error: "network" });
      current.onend?.();
    }
    assert.equal(h.recognitions.length, 3, "two immediate endings are retried");
    const last = h.recognitions.at(-1)!;
    last.onerror?.({ error: "network" });
    last.onend?.();
    assert.equal(h.recognitions.length, 3, "the third immediate ending is not retried");
    assert.equal(h.get("voice-enable").disabled, false);
    assert.match(h.get("voice-result").textContent, /keeps ending \(network\)/);
    h.enable();
    assert.equal(h.recognitions.length, 4, "the operator can enable the microphone again");
    h.recognitions.at(-1)!.onend?.();
    assert.equal(h.recognitions.length, 5, "an explicit enable starts a fresh retry allowance");
  });
});
