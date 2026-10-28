---
license: other
license_name: lfm1.0
license_link: LICENSE
base_model:
  - LiquidAI/d1-Omni-2B
pipeline_tag: audio-text-to-text
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
---

# d1-Omni-2B, compiled for the browser

Liquid AI's [d1-Omni-2B](https://huggingface.co/LiquidAI/d1-Omni-2B) compiled into a
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundle: the weights the browser runtime of
[liquidai-lmf3-wasm](https://github.com/fusor-rs/liquidai-lmf3-wasm) loads to answer named, typed
questions about a state, its images and its audio clips in one pass on the device's CPU. Try it in
the Space [fusorlabs/liquidai-lmf3-wasm](https://huggingface.co/spaces/fusorlabs/liquidai-lmf3-wasm).

- **Source:** `LiquidAI/d1-Omni-2B` at revision `4cccbfd5ba3405ee0f973134bd03e0d9d60ef1d8`,
  compiled with the `q7` profile: every large matrix 7-bit but the patch embedding and the audio
  subsampler's, kept in f32; with the checkpoint's calibration, without its speech output.
- **Format:** `manifest.json` lists every tensor and part; each part is named by its BLAKE3 hash,
  which the runtime checks as it loads.
- **Reproduce it:** `just model` in liquidai-lmf3-wasm downloads the checkpoint and compiles the same
  bundle.

This is not a PyTorch or safetensors checkpoint: it only loads in the liquidai-lmf3-wasm runtime.

The model is under the LFM Open License v1.0 ([LICENSE](LICENSE)).
