# dsh-memory

A community plugin suite (`dsh-plugin`) that makes DeepSeek Harness (DSH) memory actually work: CJK-capable full-text session search, tool-result dedup, hybrid memory retrieval, cross-session core memory, near-lossless compaction, a **skill manager with background self-evolution**, and a **provenance-audited user layer the model cannot write**. Phases 0–3 are implemented and integration-verified on a real harness; 97 unit tests pass.

> **Host requirement: DSH `>=0.1.5-rc.3 <0.3.0` (cordis `^4.0.1`), verified on 0.1.5-rc.3 and 0.2.0-rc.2.** `ctx.sessionQuery` is provided by this repo's CJK plugin as a **subclass** of upstream `SessionQueryEngine`, so it must resolve the *same* `@deepseek-ai/dsh-session-query` copy as the host — otherwise the host gets a service instance without `observeSession()`. See [issue #1](https://github.com/QIANLING-0831/dsh-memory-plus/issues/1) and the "host version contract" section of `packages/dsh-session-query-sqlite-cjk/README.md`.

---

## Why this is not "yet another memory plugin"

20+ memory plugins have appeared for DSH in the past six months (dsh-memory-evolve 205★ / dsh-mnemon 136★ / dsh-noema 116★ …). Most are single-purpose plugins, and almost all sit on top of the official `sessionQuery` service — whose `unicode61` tokenizer cannot segment Chinese, so **the entire ecosystem's Chinese recall is broken by one shared foundation bug**.

This repository is a **memory family bundle that fixes the foundation**:

1. **CJK search fix (unique in the ecosystem)** — trigram dual tables + a 1–2 char LIKE fallback; every memory plugin benefits (measured: 0 hits upstream → full hits with this bundle).
2. **Skill self-evolution** — `skill_write/delete/list` plus a background reflection loop that distills reusable skills from finished turns (Hermes-style learning loop, zero request-path overhead).
3. **A user layer the model cannot write** — skills and standing memories carry **provenance**; hand-written files and anything pinned with `/skill-pin` or `/memory-pin` are refused to model tools and to the background loop, and every refusal is written to an audit log.
4. **A topic for mistakes** — `lesson` and `correction` are first-class fact topics, so "what went wrong" is not buried in `general`.
5. **Token dedup** — hash-dedup of repeated tool results, saving input tokens.
6. **KV-safe stable injection** — injection discipline derived from source-level findings (`buildRequest` deepFreeze / KV prefix-cache invalidation / persistent-log pollution).
7. **Compaction provenance** — near-lossless summaries with exact source locators (spill path / file / seq range).

Ecosystem survey (20+ projects, with license self-check): [`docs/DSH-MEMORY-ECOSYSTEM.md`](docs/DSH-MEMORY-ECOSYSTEM.md).

---

## 1. Packages

| Package | What it does | Phase |
|---|---|---|
| [`dsh-session-query-sqlite-cjk`](packages/dsh-session-query-sqlite-cjk) | CJK-capable `sessionQuery` provider: FTS5 dual tokenizer (unicode61 + trigram) with automatic routing and a 1–2 char CJK LIKE fallback | 0 |
| [`dsh-tool-result-dedup`](packages/dsh-tool-result-dedup) | Hash-dedup of repeated tool results (`git status` / `ls` / repeated `read`) → pointer, saving input tokens | 0 |
| [`dsh-memory-index`](packages/dsh-memory-index) | Hybrid memory search service `ctx.memorySearch`: sqlite-vec vector arm + FTS5 lexical arm → RRF fusion; incremental per-event embedding; file-tag filtering | 1 |
| [`dsh-memory-tool`](packages/dsh-memory-tool) | Model-facing `memory_search` tool: bounded hybrid recall over the current session's earlier conversation | 1 |
| [`dsh-compaction-locator`](packages/dsh-compaction-locator) | Near-lossless compaction: every `<compacted-summary>` carries Exact Sources locators (spill path / file path / seq range) | 2 |
| [`dsh-memory-core`](packages/dsh-memory-core) | Cross-session core memory: workspace fact store + stable system-prompt section injection (KV-safe) + `memory_remember` tool + a **user-pinned `[pinned]` layer no tool can change** and `/memory-pin` `/memory-unpin` `/memory-list` commands | 2 |
| [`dsh-memory-skills`](packages/dsh-memory-skills) | Skill manager + background self-evolution: `skill_write/delete/list` persist DSH-native skill files; a timer-driven reflection loop distills reusable skills from finished turns; **provenance + `/skill-pin` so the model cannot rewrite a user's skills** | 3 |
| [`dsh-memory-bundle`](packages/dsh-memory-bundle) | Meta-bundle: one-command install of everything, auto-disabling conflicting base rows | integration |

---

## 2. Background: the DSH memory pipeline today

### 2.1 `unicode61` is effectively unusable for Chinese (upstream defect)

`dsh-session-query-sqlite` uses the FTS5 `unicode61` tokenizer, which does **not segment CJK text**: a run of Han characters becomes a single token. Measured (node:sqlite + FTS5):

| Query against `索引优化减少Token消耗的句子` | unicode61 (upstream) | trigram (this plugin) |
|---|---|---|
| `Token消耗` | ❌ 0 hits | ✅ hits |
| `"索引优化"` (whole phrase) | ❌ 0 hits (must reproduce the full sentence) | ✅ hits |

### 2.2 The memory pipeline is "write-only"

- **compaction**: lossy summaries; old details vanish unless spilled at the time;
- **spill**: large results leave context, but recall means the model guessing paths with `read`/`grep`;
- **indexing** (FTS5) only serves callers that actively search — it is **never wired back into model context**.

**Core insight**: make indexing a real channel from memory back into context — old content becomes precisely retrievable, so the context tail can stay short, compaction pressure drops, and identical content is never re-sent.

---

## 3. Architecture: three-layer memory + entry tags + incremental driving

| Layer | Content | Write semantics | Storage |
|---|---|---|---|
| working | current context (surface cursor) | slides every step | no store — it is the context |
| archival | full text of old events (shadowed/log-only) | **append-only** (log immutable; derived tags updatable) | derived SQLite: chunks + vec0 vectors + FTS5 |
| core | distilled cross-session facts (preferences/conventions/environment/decisions) | **CRUD**: hash dedup + similarity merge | derived SQLite: `core_facts` |
| dedup | tool-result hash table | pointer on hit | in-process (Phase 0 MVP) |
| skills | reusable skill files | CRUD via `skill_write/delete` + background evolution, provenance-tagged (`metadata.source`) | DSH-native Markdown files (`$DSH_HOME/skills`) |

### Query pipeline

```
Stage 1  entry exact filter (file:/tool:/hash:, zero embedding) → candidate set
Stage 2  hybrid retrieval: FTS5 lexical + vector semantic → RRF fusion → rerank
Stage 3  merge candidates → pointers for already-visible items → budget trim
```

### Background self-evolution (Hermes-style, DSH-disciplined)

`dsh-memory-skills` runs a fire-and-forget timer (default 60 s) that scans live sessions past a per-session watermark. Heuristic gates (assistant message length), a cooldown, and a bounded event window keep LLM cost flat. When triggered, it asks the model once — strict JSON contract — whether a finished turn produced a reusable skill, then writes/updates a DSH-native skill file atomically. Everything is logged to the derived DB (`skill_events`), and skill files are plain Markdown, so they survive plugin removal.

---

## 4. Install

> Not yet published to npm. Three ways to get it:

```sh
git clone https://github.com/QIANLING-0831/dsh-memory-plus.git
cd dsh-memory-plus
# Windows one-shot:
.\scripts\install.ps1 -Profile headless
# or manually (local paths MUST carry the ./ prefix, otherwise pnpm treats
# them as git specs; dsh and pnpm must be on PATH — pnpm can be shimmed via corepack):
dsh plugin --profile <profile> add ./packages/dsh-memory-bundle
dsh plugin --profile <profile> add ./packages/dsh-memory-skills
cd $env:DSH_HOME/profiles/<profile> && pnpm install
```

Plugin defaults live in [`packages/dsh-memory-bundle/cordis.patch.yml`](packages/dsh-memory-bundle/cordis.patch.yml) (relative derived-DB paths — use absolute paths in production).

> **Host version requirement: DSH `>=0.1.5-rc.3 <0.3.0` (cordis `^4.0.1`), verified on 0.1.5-rc.3 and 0.2.0-rc.2.**
> The `<0.3.0` upper bound is deliberate: DSH 0.2.0 added a hard pre-install/pre-boot peer gate (`evaluatePluginCompatibility`), and a declared range that does not match makes the whole tree refuse to load (issue #3). Only 0.1.5-rc.3 and 0.2.0-rc.2 have actually been exercised, so a future 0.3.0 should **fail loudly and be verified**, not be silently claimed compatible. See the "host version contract" section of [`packages/dsh-session-query-sqlite-cjk/README.md`](packages/dsh-session-query-sqlite-cjk/README.md).

## 5. Usage

The model gets five tools:

- `memory_search(query, limit, max_chars, file?)` — bounded hybrid recall over the current session's earlier conversation;
- `memory_remember(content, topic?)` — write a durable cross-session fact; it appears at the top of later requests in the same workspace (`## Persistent Memory` block). Topics include `preference` / `convention` / `environment` / `decision` / **`lesson`** / **`correction`** / `general`;
- `skill_write(name, description, whenToUse?, content)` — create/update a reusable skill **a model wrote** (DSH-native skill file, immediately visible to the session skill catalog);
- `skill_delete(name)` / `skill_list()` — delete / list skills, with provenance (`(managed:model)` / `(managed:evolve)` / `(human)` / `(pinned)`).

**The user layer (slash commands the model cannot reach).** `/skill-pin <name>` and `/skill-unpin <name>` pin a skill file; `/memory-pin [topic] <text>`, `/memory-unpin <id|text>` and `/memory-list` manage standing memories. These run through `ctx.commands`: a slash line executes against the agent, is never submitted to the model, and no model-facing tool can dispatch one — so a pin is structural, not advisory. Files the user wrote by hand or pinned are refused to `skill_write` / `skill_delete` / the evolution loop, and each refusal lands in the `skill_events` audit log. Design and measurements: [`docs/PROVENANCE-AND-PIN.md`](docs/PROVENANCE-AND-PIN.md).

## 6. Verification

Real-harness results (headless profile): full-tree startup with 8 plugins ✅, `memory_remember` ✅, `memory_search` Chinese recall ✅ (3 real records), cross-session persistence ✅. A dedicated 2026-10-01 end-to-end run covered the provenance guards: three attempts by the model to overwrite/delete a hand-written skill and to overwrite a pinned one were all refused with the user's files byte-identical afterwards, the refusals were persisted as `skill_events` rows, and `memory_remember` stored a `lesson` fact through the real tool schema. Step-by-step verification: [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## 7. Roadmap & open items

- ✅ Phase 0: CJK search fix + tool-result dedup
- ✅ Phase 1: hybrid search service + `memory_search` tool
- ✅ Phase 2: near-lossless compaction + cross-session core memory + file entity index
- ✅ Phase 3: skill manager + background self-evolution
- ✅ Phase 3.1: provenance + the user-pinned layer (`/skill-pin`, `/memory-pin`), `lesson`/`correction` topics, additive schema migration
- ⏳ Real-machine trigger verification for compaction/dedup; bge real-embedding verification; interactive verification of the slash commands (a headless profile has no command adapter — see `docs/VERIFICATION.md` §6); auto recall injection once DSH provides a "non-persistent, tail-append" seam

## License

MIT. `dsh-session-query-sqlite-cjk` is a fork of `@deepseek-ai/dsh-session-query-sqlite` (MIT).
