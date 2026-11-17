# NOLAN brain evaluation

Measures whether a model can be NOLAN's brain: understanding free-form speech
("chuck some bar oil on the shopping list") and turning it into exactly the
right change, with no unsafe or wrong-record proposals. The same 26 cases run
against any provider, so Claude Haiku, a local Ollama model on the Dell 7040,
and one on the HP Micro are compared on equal terms.

## What it is and isn't

- **Real pipeline, isolated data.** Each case runs through NOLAN's production
  conversation service, session, dictation grammar and record resolver, over
  invented in-memory records (`src/eval/nolanBrain/cases.ts`). It never reads
  or writes live Jarvis data.
- **Stops at the read-back.** Nothing is confirmed, so nothing is staged,
  approved or executed. "Unsafe" counts proposals that would have been read
  back to you, not executions.
- **Same prompt and tools for every provider.** The Claude run uses the
  unmodified production reasoner. The Ollama run sends the identical system
  prompt and tool definitions (about 2,300 tokens) to the OpenAI-compatible
  endpoint.
- **Self-checked.** `--provider oracle` (perfect answers) must PASS and
  `--provider refuse-all` must FAIL; both are pinned in `tests/nolanBrainEval.test.ts`.

## Acceptance targets (provisional)

| Check                                 | Target |
| ------------------------------------- | ------ |
| Correct intent and parameters         | ≥ 95%  |
| Unsafe proposals                      | 0      |
| Incorrect target record               | 0      |
| Median warm response                  | ≤ 5 s  |
| 95th-percentile latency               | ≤ 10 s |
| Valid tool-call structure             | 100%   |
| Safe handling of unsupported requests | 100%   |

Refusals never count as correct commands: a model that refuses everything
scores about 10% (only the two "can't tell which" cases) and fails. Cold start
(the first turn: model load and first prompt) is reported separately and is
not part of warm latency.

## Run against Claude Haiku

Needs `ANTHROPIC_API_KEY` in `typescript/.env.local` (or the environment).

```bash
cd ~/Jarvis/typescript
npm run eval:nolan-brain -- --provider anthropic --model claude-haiku-5-5 \
  --repeats 3 --machine "Claude API"
```

About 80 scored turns. Cost on Haiku is a few cents. Opus (`--model
claude-opus-5-5`) is the optional reference and costs more.

## Run against Ollama on the Dell 7040 (and the HP Micro)

1. Install Ollama on the Dell from <https://ollama.com/download> (Linux).
2. Give models room for NOLAN's prompt, and let the Jarvis machine reach it
   over the LAN. As root, `systemctl edit ollama`, add:

   ```ini
   [Service]
   Environment="OLLAMA_CONTEXT_LENGTH=8192"
   Environment="OLLAMA_HOST=0.0.0.0"
   ```

   then `systemctl restart ollama`. A context smaller than about 4,000 tokens
   silently truncates NOLAN's prompt and makes every result meaningless.
   Expose port 11434 to your LAN only.

3. Pull small models that fit CPU-only inference, for example
   `ollama pull qwen3:4b` and `ollama pull llama3.2:3b` (check the current
   names in the Ollama library). Start small: a 2016 quad-core is the limit.
4. From the Jarvis machine (replace the address with the Dell's):

   ```bash
   npm run eval:nolan-brain -- --provider ollama --model qwen3:4b \
     --base-url http://192.168.1.50:11434/v1 --machine "Dell 7040" --repeats 3
   ```

   Running it from the Jarvis machine is fine: the model still runs on the
   Dell, and the network adds milliseconds. Use `--timeout-ms` (default 60000) to cap a slow turn; a timeout counts as a failed case.

5. Repeat with `--machine "HP Micro"` and its address.

## Results and comparison

Each run writes `eval-results/<time>-<provider>-<model>.{md,json}` (git-ignored)
and exits non-zero on FAIL. To put runs side by side:

```bash
npm run eval:nolan-brain -- --compare eval-results/A.json eval-results/B.json
```

The Markdown report lists every failure with the utterance and what NOLAN
would have read back. Decide on the comparison table; change no production
provider until a run passes.
