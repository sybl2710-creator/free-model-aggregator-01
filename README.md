[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/sybl2710-creator/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/sybl2710-creator/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

A deterministic, dependency-free Node server that routes OpenAI Chat Completions and Anthropic Messages to free models across OpenAI, Anthropic, and Gemini providers. It probes catalogs once, ranks eligible models by the brief's ratings, tracks provider calls, and fails over after refusals. Both client APIs support JSON and SSE, including tool calls, images, system prompts, stop sequences, and usage translation. Upstream streams are buffered before translation so final usage and tool arguments remain intact.

Run with Node 22.18 or newer (native TypeScript support):

```sh
MAKEFUN_PROMPT_FILE=/path/to/input/prompt.txt \
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

The server chooses a local port, registers its catalog with the env, serves the workload, and exits when `/work` reports completion. Provider keys come from their named environment variables when set, otherwise from the brief. `node main.ts --list` probes and prints the same catalog without starting a listener; without a brief it prints `{"providers":[]}`.

Run a practice trial directly against the read-only kit, using Python 3 only for the development launcher:

```sh
python3 scripts/practice.py 0 --kit /path/to/free-model-aggregator-01-kit
```

Repeat with `1` and `2`. The launcher starts the env with its input data, runs the server, exports state, invokes the kit scorer, and verifies the catalog listing matches registration. Output goes to a temporary directory or the directory supplied with `--output`.

For development environments that prohibit loopback sockets, the test-only runner uses an in-memory HTTP transport with the unchanged kit env and client checks:

```sh
node scripts/memory-practice.mjs /path/to/free-model-aggregator-01-kit 0 /tmp/aggregator-trial-0
MAKEFUN_OUTPUT_DIR=/tmp/aggregator-trial-0/export \
MAKEFUN_REFERENCE_DIR=/path/to/free-model-aggregator-01-kit/practice/trial-0/reference \
MAKEFUN_SCORES_DIR=/tmp/aggregator-trial-0/scores \
node /path/to/free-model-aggregator-01-kit/program/scorer/score.mjs
```

This fallback validates routing and wire behavior but does not validate real TCP transport. The submitted entry uses only Node's standard library and does not import either practice runner.

<sub>Entered on [make.fun](https://make.fun/?ref=cxn0skwa&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
