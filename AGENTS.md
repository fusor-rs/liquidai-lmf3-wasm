# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

liquidai-lmf3-wasm is Liquid AI's LFM3 collection in one page, a model picker
choosing among the models it runs. Today it runs six: LFM3-1.7B
(LiquidAI/LFM3-1.7B), a text chat model (gated short convolutions between
sliding-window and full attention layers, each attention head's output gated);
LFM3-VL-2B (LiquidAI/LFM3-VL-2B), the same language model reading images
too through its vision tower (gated 2-D convolutions between attention layers)
and projector; LFM3-Audio-2B (LiquidAI/LFM3-Audio-2B), the same language model
hearing speech through its audio encoder and speaking through a depth decoder
and the Liquid codec; LFM3-Omni-2B (LiquidAI/LFM3-Omni-2B), which does both;
and the decision models d1-2B (LiquidAI/d1-2B) and d1-Omni-2B
(LiquidAI/d1-Omni-2B), LFM3-VL-2B's and LFM3-Omni-2B's backbones fine-tuned to
answer named, typed questions about a state and its media in one pass,
generating nothing. Each runs in the browser on the CPU, sealed from the
network: a chat model holding a conversation and streaming each reply, its
reasoning apart when it thinks first; a decision model answering each request.
The README describes what it does; don't invent scope, features or options
beyond the task.

## Repository

- `vendor/fusor-ai/models/lfm3/runtime`: the wasm-bindgen surface of every
  LFM3 model (bundle parts, and each turn's message as JSON with its images' RGBA
  pixels and its clips' 16 kHz samples in, the reply so far as JSON and its
  speech's 24 kHz samples out, and a reset for a new conversation),
  built as four browser runtimes; the bundle names its model.
- `vendor/fusor-ai/models/lfm3/cli`: the native CLI `lfm3`
  (`compile`, `chat`, `bench`, `parity`).
- `vendor/fusor-ai/models/d1/runtime` and `vendor/fusor-ai/models/d1/cli`: the
  decision models' wasm-bindgen surface (bundle parts, and each request as JSON
  with its images' RGBA pixels and its clips' 16 kHz samples in, then each step's
  progress, the last with every answer, out), built as four browser runtimes of
  their own beside LFM3's (`just runtimes`), and the native CLI `d1` (`compile`, `decide`,
  `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace (fusor pins wasm-bindgen 0.2.117, the runtime 0.2.129): the
  conversation, the next message and its images, how to reply, the models to
  pick from and the live measurements as Rust signals in `src/app.rs`, the
  example messages and requests in `src/examples.rs` (the requests' questions in
  `src/presets/`), a decision model's request and answers in `src/decision.rs`,
  the template in `web/index.html`, the
  engine bridge, the models (`MODELS`), the images' and clips' decoding, the
  microphone and the speech's playback in `web/app.js`,
  and in `engine/` the engine workers (`worker.js` for LFM3, `d1.js` for d1),
  beside the runtimes `just runtimes` builds.
- `scripts/`: each model's checkpoint download and the fixed media's (pinned,
  sha256-checked), the Node smoke test and the agreement with the reference
  (`agreement.mjs`) and the README's banner (`render-images.mjs`);
  `e2e/run.mjs`: the headless Chrome run; `fixtures/`: each model's
  conversations (`conversations/<model>.json`) or a decision model's requests
  (`requests/<model>.json`), and the reference's replies or answers
  (`references/<model>.json`); `space/`: the Space's card and each bundle's
  (`models/<model>.md`).
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the models (`lfm3`, `d1`),
  their compilers (`lfm3-compile`, `d1-compile`), the kernels, blocks and bundle format come
  from `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai,
  with the browser loader and compute pool, the runtime build, the import check
  and the dev server.

What belongs where: model code (the chat template, the tensor names, the
sampling and the conversation's state) and anything another model could reuse go
to fusor-ai, following its `AGENTS.md`. This repository holds what turns the
model into an app: the page, the checks against the reference and the
deployment. A change to fusor-ai lands there first; this repository never
patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity results and the e2e
  result it gave. No copies of fusor-ai code here.
- The reference is each checkpoint's own modeling code (`Lfm3ForCausalLM`,
  `Lfm3VlForConditionalGeneration`, d1's `D1Model`) and tokenizer or processor
  at the pinned revision and the versions the justfile pins, in f32 on the CPU,
  each conversation turn by turn, each reply greedy, each request through
  `system_one`. Every
  turn's prompt must be the reference's, token for token; every fixed reply must
  state the facts its turn expects.
- The page owns every capability: drawing each reply's seed, decoding the
  images, caching the bundle (OPFS) and measuring itself. The runtime receives
  the message and the images' pixels and does no I/O. Nothing is fetched while
  replying.
- The weights are under the LFM Open License v1.0: the page and the README
  credit Liquid AI with links, and each bundle ships the license beside it
  (`model/<model>/LICENSE`). Don't remove it.
- A model of the collection joins the page as one entry of `MODELS` in
  `web/app.js` and one name in the justfile's `models`: its checkpoint in
  `scripts/fetch-checkpoint.sh`, its bundle in `dist/model/<model>`, its fixed
  conversations in `fixtures/conversations/<model>.json` (a decision model's
  requests in `fixtures/requests/<model>.json`), its card in
  `space/models/<model>.md`, its model crate (or variant) in fusor-ai.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtime and the CLI. A change to the runtime,
the page, the CLI or fusor-ai also needs `just runtimes`, `just smoke`, `just
parity` (the same results as before unless the change is meant to move them) and
`just e2e`, whose every fixed reply must state the facts its turn expects; a
change meant to move speed also needs `just bench`. The model is checked stage
by stage against the reference goldens by `lfm3 parity`; extend it rather
than adding a parallel harness.

## Measuring

A speed change is judged on the page (`web-threaded-relaxed`, 8 workers, headless
Chrome through `just e2e`): the time from Send to the first token and the tokens
written per second after it. Medians of at least three fresh-profile runs with
their spread and the machine's load average; a change smaller than the spread is
not a result, and nothing else runs on the machine during a measurement.
`lfm3 bench` explains where the time went, stage by stage. Numerically
every accepted change is bit-exact unless it is meant to move the numbers: the
fixed conversations get the same replies, `just parity` prints the same digits.
fusor-ai's `knowledge.md` records what the measurements taught about V8, the
kernels and their stores.

## Commits

- Don't commit, push, tag, release or deploy unless asked.
- Clone fusor repositories with
  `https://andreespirela@github.com/fusor-rs/<name>.git`.
