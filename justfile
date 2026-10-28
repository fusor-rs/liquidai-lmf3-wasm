# Liquid AI's LFM3 collection in the browser, a model picker choosing among the models it runs.
# `just ui` builds everything, every model included, and serves the page; `just build` then
# `just serve` do the same in two steps.

# `native` and `runtimes` below are product.just's for both of the page's fusor-ai models: LFM3's
# CLI and runtimes (in app/engine/dist), and d1's (its runtimes in app/engine/dist/d1).
set allow-duplicate-recipes

import 'vendor/fusor-ai/just/product.just'

name := "lfm3"
# The models the page runs, each one entry of `MODELS` in app/web/app.js: its checkpoint in
# <checkpoints>/<model>, its bundle in dist/model/<model>, its fixed conversations in
# fixtures/conversations/<model>.json, or a decision model's (d1-*) fixed requests in
# fixtures/requests/<model>.json.
models := "lfm3-1.7b lfm3-vl-2b lfm3-audio-2b lfm3-omni-2b d1-2b d1-omni-2b"
# In a loop over the models' `id`, its CLI, the word its id starts with (lfm3 or d1), and its
# fixed conversations or requests.
cli := '${id%%-*}'
fixed_inputs := 'fixtures/$([ ${id%%-*} = d1 ] && echo requests || echo conversations)/$id.json'
# The largest bundle, the conversation's state and the activations.
export MAX_MEMORY := "4294967296"
checkpoints := env_var_or_default("CHECKPOINTS", ".cache")
goldens := "fixtures/goldens"
media := "fixtures/media"
# The reference the goldens come from (vendor/fusor-ai/models/lfm3/reference): the
# checkpoint's own modeling code under transformers, pinned.
reference := "uv run --no-project --python 3.12 --with transformers==5.21.0 --with torch==2.9.1 --with torchvision==0.24.1 --with numpy==2.5.4 --with pillow==13.0.0 --with safetensors==0.8.0 --with huggingface-hub==1.33.0 python"
# d1's reference (vendor/fusor-ai/models/d1/reference): its checkpoints' own code, under the
# transformers their configurations pin.
d1_reference := "uv run --no-project --python 3.12 --with transformers==5.19.0 --with torch==2.9.1 --with torchvision==0.24.1 --with numpy==2.5.4 --with pillow==13.0.0 --with safetensors==0.8.0 --with huggingface-hub==1.33.0 python"

host:
    bash -n scripts/fetch-checkpoint.sh
    bash -n scripts/fetch-media.sh
    node --check app/web/app.js
    node --check app/engine/worker.js
    node --check app/engine/d1.js
    node --check scripts/node-smoke.mjs
    node --check scripts/agreement.mjs
    node --check scripts/demo.mjs
    node --check scripts/render-images.mjs
    node --check scripts/site-bundle.mjs
    node --check e2e/run.mjs

# Downloads each model's pinned checkpoint (3.5 GB, 3.9 GB, 4.2 GB, 4.5 GB, 3.9 GB and 4.4 GB,
# sha256-checked) unless it is already there, then compiles its bundle into dist/model/<model>, its
# license beside it.
model: native
    for id in {{models}}; do \
      scripts/fetch-checkpoint.sh {{checkpoints}}/$id $id || exit 1; \
      rm -rf {{model}}/$id; \
      target/release/{{cli}} compile {{checkpoints}}/$id {{model}}/$id || exit 1; \
      cp {{checkpoints}}/$id/LICENSE {{model}}/$id/; \
    done

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

native:
    cd {{fusor_ai}} && {{nice}} cargo build --release -p {{name}}-cli -p d1-cli --target-dir {{justfile_directory()}}/target

# LFM3's and d1's four browser runtimes each, fusor-ai's loader and worker kit next to them, and
# the sealed-runtime check.
runtimes: tools
    for crate in {{name}} d1; do \
      out={{engine}}; [ $crate = d1 ] && out={{engine}}/d1; \
      for variant in {{variants}}; do \
        {{nice}} {{fusor_ai}}/scripts/build-runtime.sh $crate-runtime $variant $out || exit 1; \
        flags=""; case $variant in *threaded*) flags="--threaded";; esac; case $variant in *relaxed*) ;; *) flags="$flags --no-relaxed";; esac; \
        node {{fusor_ai}}/scripts/check-wasm-imports.mjs $out/$variant/${crate}_runtime_bg.wasm --glue $out/$variant/${crate}_runtime.js $flags || exit 1; \
      done; \
    done
    mkdir -p {{engine}}/host
    cp {{fusor_ai}}/packages/host/loader.js {{fusor_ai}}/packages/host/worker.js {{engine}}/host/

# Every stage of every model against the reference's goldens
# (vendor/fusor-ai/models/<cli>/reference).
parity: model fixtures
    for id in {{models}}; do \
      test -d {{goldens}}/$id || just goldens; \
      target/release/{{cli}} parity {{model}}/$id {{goldens}}/$id/golden_f32_*.safetensors || exit 1; \
    done

# Golden tensors of every model's conversations or requests, and the reference's replies or
# answers (fixtures/references/<model>.json), from the reference in f32 on the CPU.
goldens: fixtures
    for id in {{models}}; do \
      scripts/fetch-checkpoint.sh {{checkpoints}}/$id $id || exit 1; \
      python="{{reference}}"; case $id in d1-*) python="{{d1_reference}}";; esac; \
      $python {{fusor_ai}}/models/{{cli}}/reference/dump.py {{checkpoints}}/$id {{fixed_inputs}} {{media}} {{goldens}}/$id fixtures/references/$id.json || exit 1; \
    done

# Every model's conversations of the fixtures, replied to by the native CLI, and every decision
# model's requests, decided by it.
chat: native fixtures
    for id in {{models}}; do \
      command=chat; case $id in d1-*) command=decide;; esac; \
      target/release/{{cli}} $command {{model}}/$id {{fixed_inputs}} --media {{media}} || exit 1; \
    done

bench id="lfm3-1.7b" case="colors": native fixtures
    id={{id}}; target/release/{{cli}} bench {{model}}/$id {{fixed_inputs}} {{case}} --media {{media}}

# The README's demo, assets/demo/demo.gif: the real page, served with dist/model, recorded in
# headless Chrome while LFM3-VL-2B reads the fixed receipt. ffmpeg comes from imageio-ffmpeg.
demo: model runtimes page fixtures
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    FFMPEG=$(uv run --no-project --with imageio-ffmpeg==0.6.0 python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())') node scripts/demo.mjs

# The README's banner and benchmark summary, light and dark.
images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

# Its tensor parts are named by their BLAKE3, so /model/parts/ can be cached as immutable.
# The page, its runtimes (four builds each of lfm3's and d1's) and the bundle beside it, as a static
# site in target/site.
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    for id in {{models}}; do \
      node scripts/site-bundle.mjs {{model}}/$id target/site/model/$id && \
      cp {{model}}/$id/LICENSE target/site/model/$id/ || exit 1; \
    done

# The Space holds at most 1 GB, so it gets the page, the runtimes and the models' licenses, and the
# page loads each model's bundle from the model repo fusorlabs/<model>-web (`just deploy-model`). The Space must
# already exist as a static Space: creating it with the upload makes a Gradio Space, which
# Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/liquidai-lmf3-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --include NOTICE --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/liquidai-lmf3-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy liquidai-lmf3-wasm {{version}}",
    )
    PY

# Deploy them before the Space whenever a bundle changes: the runtime only loads a bundle compiled
# with the same fusor-ai.
# Each of the site's bundles, with space/models/<model>.md as its card, to the model repo
# fusorlabs/<model>-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    for id in {{models}}; do cp space/models/$id.md target/site/model/$id/README.md; done
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model {{models}} <<'PY'
    import sys
    from pathlib import Path
    from huggingface_hub import HfApi

    api = HfApi()
    for model in sys.argv[2:]:
        repo = f"fusorlabs/{model}-web"
        api.create_repo(repo, exist_ok=True)
        api.upload_folder(
            repo_id=repo,
            folder_path=str(Path(sys.argv[1]) / model),
            delete_patterns="*",
            commit_message="Deploy the liquidai-lmf3-wasm {{version}} bundle",
        )
    PY

# The fixed inputs the checks read: the images of the fixed conversations.
fixtures:
    scripts/fetch-media.sh {{media}}
