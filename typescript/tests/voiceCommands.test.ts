import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VOICE_CONTROL_PHRASES,
  VOICE_COMMANDS,
  VOICE_PROFILES,
  findVoiceCommand,
  normalizeUtterance,
} from "../src/voice/voiceCommands.js";

describe("voice command catalog", () => {
  it("defines exactly the four owner-requested profiles", () => {
    assert.deepEqual([...VOICE_PROFILES].sort(), ["client", "crawler", "trailer", "workshop"]);
  });

  it("holds between 20 and 40 bounded commands", () => {
    assert.ok(
      VOICE_COMMANDS.length >= 20 && VOICE_COMMANDS.length <= 40,
      `expected 20-40 commands, got ${VOICE_COMMANDS.length}`,
    );
  });

  it("represents every profile with at least one command", () => {
    for (const profile of VOICE_PROFILES) {
      assert.ok(
        VOICE_COMMANDS.some((command) => command.profile === profile),
        `profile ${profile} has no commands`,
      );
    }
  });

  it("uses unique command ids", () => {
    const ids = VOICE_COMMANDS.map((command) => command.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("keeps every normalized phrase globally unique so an utterance maps to at most one command", () => {
    const phrases: string[] = [];
    for (const command of VOICE_COMMANDS) {
      for (const phrase of command.phrases) phrases.push(normalizeUtterance(phrase));
    }
    assert.equal(
      new Set(phrases).size,
      phrases.length,
      "duplicate normalized phrase across catalog",
    );
  });

  it("stores phrases already in normalized form (no silent re-normalization drift)", () => {
    for (const command of VOICE_COMMANDS) {
      for (const phrase of command.phrases) {
        assert.equal(phrase, normalizeUtterance(phrase), `phrase "${phrase}" is not normalized`);
      }
    }
  });

  it("never lets a catalog phrase collide with a reserved control phrase", () => {
    const control = new Set(
      [...VOICE_CONTROL_PHRASES.confirm, ...VOICE_CONTROL_PHRASES.cancel].map(normalizeUtterance),
    );
    for (const command of VOICE_COMMANDS) {
      for (const phrase of command.phrases) {
        assert.ok(
          !control.has(normalizeUtterance(phrase)),
          `phrase "${phrase}" collides with a control phrase`,
        );
      }
    }
  });

  it("requires a spoken confirmation for every critical command", () => {
    for (const command of VOICE_COMMANDS) {
      if (command.criticality === "critical") {
        assert.equal(
          command.requiresSpokenConfirmation,
          true,
          `critical command ${command.id} must require spoken confirmation`,
        );
      }
    }
  });

  it("binds actuation commands to a hardware target and nothing else", () => {
    for (const command of VOICE_COMMANDS) {
      if (command.kind === "actuate") {
        assert.ok(
          command.actuationTarget,
          `actuate command ${command.id} needs an actuationTarget`,
        );
        assert.equal(
          command.proposes,
          undefined,
          `actuate command ${command.id} must not propose a tool`,
        );
      } else {
        assert.equal(
          command.actuationTarget,
          undefined,
          `${command.id} is not actuate but has a target`,
        );
      }
    }
  });

  it("describes quote follow-up as unavailable until the governed sent-quote read exists", () => {
    const command = VOICE_COMMANDS.find((entry) => entry.id === "client.quote-follow-up");
    assert.ok(command);
    assert.match(command.summary, /lifecycle delivery ledger/i);
    assert.doesNotMatch(command.summary, /daily brief marks/i);
  });

  it("describes reminders as including dates beyond the brief window", () => {
    const command = VOICE_COMMANDS.find((entry) => entry.id === "client.reminders");
    assert.ok(command);
    assert.match(command.summary, /beyond the 24-hour/i);
  });

  it("binds governed proposals to a tool/operation and never actuate", () => {
    for (const command of VOICE_COMMANDS) {
      if (command.kind === "propose") {
        assert.ok(
          command.proposes?.tool && command.proposes?.operation,
          `propose command ${command.id} needs proposes`,
        );
      }
    }
  });

  it("keeps queries free of side-effect bindings", () => {
    for (const command of VOICE_COMMANDS) {
      if (command.kind === "query") {
        assert.equal(command.actuationTarget, undefined);
        assert.equal(command.proposes, undefined);
      }
    }
  });

  describe("normalizeUtterance", () => {
    it("lowercases, trims, and collapses internal whitespace", () => {
      assert.equal(normalizeUtterance("  Crawler   STATUS  "), "crawler status");
    });

    it("strips surrounding punctuation an ASR engine may append", () => {
      assert.equal(normalizeUtterance("Crawler status."), "crawler status");
      assert.equal(normalizeUtterance("stop?!"), "stop");
    });

    it("is idempotent", () => {
      const once = normalizeUtterance("  Deploy  the Ramp! ");
      assert.equal(once, normalizeUtterance(once));
    });
  });

  describe("findVoiceCommand", () => {
    it("resolves a normalized phrase within its profile", () => {
      const command = findVoiceCommand("crawler", "crawler status");
      assert.equal(command?.profile, "crawler");
      assert.equal(command?.kind, "query");
    });

    it("does not resolve a phrase from a different profile", () => {
      const crawlerPhrase = VOICE_COMMANDS.find((c) => c.profile === "crawler")?.phrases[0];
      assert.ok(crawlerPhrase);
      assert.equal(findVoiceCommand("client", crawlerPhrase), undefined);
    });

    it("returns undefined for an unknown utterance", () => {
      assert.equal(findVoiceCommand("workshop", "make me a sandwich"), undefined);
    });
  });
});
