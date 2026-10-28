#!/usr/bin/env bash
# Downloads the fixed media the checks read into $1, each pinned by revision and checked by sha256
# (files already present are only checked): the receipt of the d3 model card's examples
# (vllm-sr/d3-nano, Apache-2.0), which LFM3-VL-2B's and LFM3-Omni-2B's fixed conversations and
# d1-2B's and d1-Omni-2B's fixed requests ask about, and a woman's voice, 16-bit mono at 16 kHz
# (hf-internal-testing/dummy-audio-samples), which LFM3-Audio-2B's and LFM3-Omni-2B's transcribe
# and d1-Omni-2B's fixed requests ask about.
set -euo pipefail
DIR="$1"
FILES="
b9dbb8b103bacd45f1de824d844a3c07b81d57cb1a7466712ef060ad7dcb3926  https://huggingface.co/vllm-sr/d3-nano/resolve/462efc366229ea268cf4eed3738b3fc4415e4817/assets/example-receipt.png
c27ae47421436287a6bd2c3062de2dc2a2855b78c0bb626d472202c359704203  https://huggingface.co/datasets/hf-internal-testing/dummy-audio-samples/resolve/798f2c7208aacc481351b60b8a39605d8bdae7c2/en-Alice_woman.wav
"
mkdir -p "$DIR"
while read -r _ url; do
  file="$(basename "$url")"
  if [ -z "$url" ] || [ -s "$DIR/$file" ]; then continue; fi
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$url"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { n = split($2, parts, "/"); print $1 "  " parts[n] }' <<< "$FILES" | shasum -a 256 -c --quiet -)
