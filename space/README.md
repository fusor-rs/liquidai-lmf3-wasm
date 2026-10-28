---
title: liquidai-lmf3-wasm
short_description: Chat with LFM3 in text, images and speech, on your CPU
sdk: static
app_file: index.html
pinned: false
license: other
license_name: lfm1.0
models:
  - fusorlabs/lfm3-1.7b-web
  - LiquidAI/LFM3-1.7B
  - fusorlabs/lfm3-vl-2b-web
  - LiquidAI/LFM3-VL-2B
  - fusorlabs/lfm3-audio-2b-web
  - LiquidAI/LFM3-Audio-2B
  - fusorlabs/lfm3-omni-2b-web
  - LiquidAI/LFM3-Omni-2B
  - fusorlabs/d1-2b-web
  - LiquidAI/d1-2B
  - fusorlabs/d1-omni-2b-web
  - LiquidAI/d1-Omni-2B
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

A conversation with Liquid AI's LFM3 models, computed on your own CPU in the browser: pick
[LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) for text, reasoning first when asked,
[LFM3-VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B) to ask about images too,
[LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B) to talk with it in speech, or
[LFM3-Omni-2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B) for all of it; or have
[d1-2B](https://huggingface.co/LiquidAI/d1-2B) or [d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B)
answer named, typed questions about a state, its images and, for d1-Omni-2B, its clips. Each model,
compiled to WebAssembly with fusor-ai, downloads once and then runs sealed from the network, writing
each reply as you read it. The models are under the LFM Open License v1.0; each one's license ships
beside its bundle as `model/<model>/LICENSE`. The page's code is MIT; its source is
[github.com/fusor-rs/liquidai-lmf3-wasm](https://github.com/fusor-rs/liquidai-lmf3-wasm).
