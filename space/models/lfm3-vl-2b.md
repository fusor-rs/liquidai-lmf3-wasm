---
license: other
license_name: lfm1.0
license_link: LICENSE
base_model:
  - LiquidAI/LFM3-VL-2B
pipeline_tag: image-text-to-text
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
---

# LFM3-VL-2B, compiled for the browser

Liquid AI's [LFM3-VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B) compiled into a
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundle: the weights the browser runtime of
[liquidai-lmf3-wasm](https://github.com/fusor-rs/liquidai-lmf3-wasm) loads to hold a conversation
about images on the device's CPU. Try it in the Space
[fusorlabs/liquidai-lmf3-wasm](https://huggingface.co/spaces/fusorlabs/liquidai-lmf3-wasm).

- **Source:** `LiquidAI/LFM3-VL-2B` at revision `f83d2b0a2296aaa277f394990a9b8b949ddf9691`,
  compiled with the `q7` profile: every large matrix 7-bit but the patch embedding, kept in f32.
- **Format:** `manifest.json` lists every tensor and part; each part is named by its BLAKE3 hash,
  which the runtime checks as it loads.
- **Reproduce it:** `just model` in liquidai-lmf3-wasm downloads the checkpoint and compiles the same
  bundle.

This is not a PyTorch or safetensors checkpoint: it only loads in the liquidai-lmf3-wasm runtime.

The model is under the LFM Open License v1.0 ([LICENSE](LICENSE)).
