Validation used the kit's unchanged env, driver, response checks, and scorer through `scripts/memory-practice.mjs`. This workspace denies socket creation (`PermissionError: [Errno 1] Operation not permitted`), so the requested TCP trial launcher could not run. The fallback replaces only HTTP transport with in-memory request/response delivery; these are local practice results, not official trial receipts. Runtime available here: Node v24.22.1; the server uses Node 22-compatible standard-library APIs and native TypeScript syntax.

| Trial | Score | Quality | Served | Wire | Failover | Catalog | Provider calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 99 | 99 | 100 | 100 | 100 | 100 | 28 |
| 1 | 99 | 99 | 100 | 100 | 100 | 100 | 29 |
| 2 | 99 | 99 | 100 | 100 | 100 | 100 | 30 |

Each workload served all 20 requests. Inference calls include actual refusals; catalog probes are not inference calls. Routing reads the provider directory and quality table at runtime. Trial budgets are unpublished according to the brief, so routing learns availability from response errors and balances equally rated providers using observed call counts.

Trial-0's two state exports were byte-for-byte identical. SHA-256:

```
644e44b42fc25eb3dbfcec7478d392def83bd01d3be053a819a5f72df3884c22
```

With a brief and the test env, `--list` exits 0, prints ten probed providers, and exactly equals `JSON.stringify(registeredCatalog) + '\n'`. With `MAKEFUN_PROMPT_FILE` and `MAKEFUN_ENV_URL` absent, `node main.ts --list` exits 0 and prints `{"providers":[]}`.

`node scripts/wire.test.ts` passes three focused tests covering tool history and image translation, byte-fragmented OpenAI SSE with late usage and tool arguments, and Anthropic tool deltas and stop reasons.

Artifacts are under `/tmp/aggregator-final-{0,1,2}/`, `/tmp/aggregator-final-0-replay/`, and `/tmp/aggregator-final-list.json`. Reproduce with the commands in README.md. The production entry never imports test transport code.
