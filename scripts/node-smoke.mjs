// Runs a single-threaded wasm runtime build in Node against each model's bundle (every directory
// of the bundles' with fixed conversations or requests, or those `--models` names): pushes every
// part the way the browser loader does, then holds each conversation of
// fixtures/conversations/<model>.json turn by turn (its PNG images and 16-bit 16 kHz WAV clips
// decoded here), step by step as the page does, and prints each reply's speed, the seconds it
// spoke and how loud, the facts it states and how much of the reference's reply
// (fixtures/references/<model>.json) it repeats; a turn that asks for speech must speak. A
// decision model (d1-*) answers each request of fixtures/requests/<model>.json, and every answer
// must make the reference's decision. With `--out`, each conversation's replies are written to
// `<dir>/<model>-<conversation>.txt` and each spoken reply to `<dir>/<model>-<conversation>.<turn>.wav`,
// each request's answers to `<dir>/<model>-<request>.txt`.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--models lfm3-1.7b,d1-2b]
//     [--media fixtures/media] [--out dir]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';
import { AUDIBLE, agreement, decision, missing, shown, SPEAKS, SPOKEN_RATE } from './agreement.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    models: { type: 'string' },
    media: { type: 'string', default: 'fixtures/media' },
    out: { type: 'string' },
  },
});
const CHUNK = 8 << 20;
// 2^15, which 16-bit samples divide by.
const PCM_SCALE = 32768;
const WAV_HEADER = 44;
const glues = {};

const bundles = positionals[0] ?? 'dist/model';
const fixtures = (model) => ['conversations', 'requests'].find((kind) => existsSync(`fixtures/${kind}/${model}.json`));
const models = values.models?.split(',') ?? readdirSync(bundles).filter(fixtures);
if (values.out) mkdirSync(values.out, { recursive: true });
let failed = false;
for (const model of models) {
  const kind = fixtures(model);
  const cases = JSON.parse(readFileSync(`fixtures/${kind}/${model}.json`, 'utf8'));
  const references = JSON.parse(readFileSync(`fixtures/references/${model}.json`, 'utf8'));
  const crate = kind === 'requests' ? 'd1' : 'lfm3';
  glues[crate] ??= await glueOf(crate);
  const runtime = load(join(bundles, model), glues[crate]);
  for (const [name, fixed] of Object.entries(cases)) {
    const check = kind === 'requests' ? decide : converse;
    failed = check(runtime, `${model} ${name}`, fixed, references[name]) || failed;
  }
  runtime.free();
}
if (failed) process.exit(1);

/** Answers a decision model's request; whether an answer's decision differs from the
 * reference's. */
function decide(runtime, name, { images = [], clips = [], ...request }, references) {
  const start = performance.now();
  const { rgba, layout } = pictures(images);
  const samples = heard(clips, layout);
  JSON.parse(runtime.start(JSON.stringify(request), rgba, samples, JSON.stringify(layout)));
  let progress = JSON.parse(runtime.step());
  while (!progress.response) progress = JSON.parse(runtime.step());
  const { answers, usage } = progress.response;
  const differing = Object.keys(references).filter((question) => JSON.stringify(decision(answers[question])) !== JSON.stringify(decision(references[question])));
  console.log(`  ${name}: ${usage.input_tokens} tokens read in ${((performance.now() - start) / 1000).toFixed(2)}s; ${differing.length ? `decides otherwise on ${differing.join(', ')}` : "every decision the reference's"}`);
  for (const [question, answer] of Object.entries(answers)) console.log(`    ${question}: ${JSON.stringify(decision(answer))}`);
  if (values.out) writeFileSync(join(values.out, `${name.replace(' ', '-')}.txt`), `${JSON.stringify(answers, null, 2)}\n`);
  return differing.length > 0;
}

/** The clips' samples one after another, their lengths in `layout`. */
function heard(clips, layout) {
  const decoded = clips.map((file) => readWav(readFileSync(join(values.media, file))));
  const samples = new Float32Array(decoded.reduce((sum, clip) => sum + clip.length, 0));
  decoded.reduce((at, clip) => (samples.set(clip, at), at + clip.length), 0);
  layout.clips = decoded.map((clip) => clip.length);
  return samples;
}

/** Holds a conversation, turn by turn; whether a reply left out a fact its turn expects. */
function converse(runtime, name, { turns }, references) {
  let missed = false;
  runtime.reset();
  const replies = [];
  turns.forEach(({ expect = [], images = [], audio = [], ...message }, index) => {
    const start = performance.now();
    const { rgba, layout } = pictures(images);
    const samples = heard(audio, layout);
    const plan = JSON.parse(runtime.start(JSON.stringify(message), rgba, samples, JSON.stringify(layout)));
    let progress = JSON.parse(runtime.step());
    let first = null;
    const speech = [runtime.speech()];
    while (!progress.done) {
      first ??= progress.tokens || progress.frames ? performance.now() : null;
      progress = JSON.parse(runtime.step());
      speech.push(runtime.speech());
    }
    const spoken = speech.reduce((sum, chunk) => sum + chunk.length, 0);
    const loudness = Math.sqrt(speech.reduce((sum, chunk) => chunk.reduce((total, sample) => total + sample * sample, sum), 0) / Math.max(spoken, 1));
    const silent = SPEAKS.includes(message.mode) && loudness < AUDIBLE;
    const seconds = (performance.now() - start) / 1000;
    const written = (performance.now() - (first ?? start)) / 1000;
    const reply = progress.reasoning === null ? progress.answer : `${progress.reasoning}\n${progress.answer}`;
    const left = missing(expect, progress.answer);
    const repeated = agreement(shown(references[index], message.thinking), reply);
    console.log(`  ${name} ${index}: ${plan.prompt_tokens} tokens read, ${progress.tokens} written and ${(spoken / SPOKEN_RATE).toFixed(1)}s spoken (RMS ${loudness.toFixed(3)}${silent ? ', silent' : ''}) in ${seconds.toFixed(2)}s (${((progress.tokens + progress.frames - 1) / written).toFixed(1)} rows/s); ${left.length ? `missing ${left.join(', ')}` : `states ${expect.join(', ') || 'nothing asked'}`}; ${(repeated * 100).toFixed(0)}% of the reference's reply repeated`);
    console.log(`    ${JSON.stringify(progress.answer)}`);
    missed ||= left.length > 0 || silent;
    if (values.out && spoken) writeFileSync(join(values.out, `${name.replace(' ', '-')}.${index}.wav`), wav(speech, spoken));
    replies.push(reply);
  });
  if (values.out) writeFileSync(join(values.out, `${name.replace(' ', '-')}.txt`), `${replies.join('\n\n---\n\n')}\n`);
  return missed;
}

/** A runtime of `glue` with every part of the bundle in `bundle` pushed into it. */
function load(bundle, glue) {
  const t0 = performance.now();
  const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const runtime = new glue.Runtime(manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundle, part.file));
    for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${bundle}: engine not ready after every part`);
  console.log(`${values.build} ${bundle}: load ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  return runtime;
}

/** `crate`'s runtime glue of the build, initialized: LFM3's in app/engine/dist, d1's beside it. */
async function glueOf(crate) {
  const dist = new URL(`../app/engine/dist/${crate === 'd1' ? 'd1/' : ''}${values.build}/`, import.meta.url);
  const glue = await import(new URL(`${crate}_runtime.js`, dist));
  glue.initSync({ module: readFileSync(new URL(`${crate}_runtime_bg.wasm`, dist)) });
  return glue;
}

/** Spoken `chunks` of `length` samples in all as a 16-bit mono PCM WAV file. */
function wav(chunks, length) {
  const bytes = Buffer.alloc(WAV_HEADER + length * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(WAV_HEADER - 8 + length * 2, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SPOKEN_RATE, 24);
  bytes.writeUInt32LE(SPOKEN_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(length * 2, 40);
  let at = WAV_HEADER;
  for (const chunk of chunks) {
    for (const sample of chunk) at = bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * (PCM_SCALE - 1)), at);
  }
  return bytes;
}

/** A turn's images as the runtime takes them: RGBA pixels and their layout. */
function pictures(images) {
  const decoded = images.map((file) => readPng(readFileSync(join(values.media, file))));
  const rgba = new Uint8Array(decoded.reduce((sum, picture) => sum + picture.rgba.length, 0));
  let at = 0;
  for (const picture of decoded) {
    rgba.set(picture.rgba, at);
    at += picture.rgba.length;
  }
  return { rgba, layout: { images: decoded.map(({ width, height }) => [width, height]) } };
}

/** The samples of a 16-bit mono PCM WAV file, in [−1, 1). */
function readWav(bytes) {
  let at = 12;
  while (bytes.toString('ascii', at, at + 4) !== 'data') at += 8 + bytes.readUInt32LE(at + 4);
  const data = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at + 4));
  return Float32Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / PCM_SCALE);
}

/** The pixels of an 8-bit, non-interlaced PNG (grey, grey and alpha, RGB or RGBA), as RGBA. */
function readPng(bytes) {
  const CHANNELS = { 0: 1, 4: 2, 2: 3, 6: 4 };
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      if (body[8] !== 8 || body[12] !== 0 || !(body[9] in CHANNELS)) throw new Error('an 8-bit, non-interlaced PNG expected');
      channels = CHANNELS[body[9]];
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      pixels[y * stride + x] = (line[x] + predict(filter, left, up, corner)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const pixel = pixels.subarray(i * channels, (i + 1) * channels);
    const [r, g, b] = channels >= 3 ? pixel : [pixel[0], pixel[0], pixel[0]];
    rgba.set([r, g, b, channels % 2 === 0 ? pixel[channels - 1] : 255], i * 4);
  }
  return { width, height, rgba };
}

/** PNG's filter predictor of a byte from its left, upper and upper-left neighbours. */
function predict(filter, left, up, corner) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  const estimate = left + up - corner;
  const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
  return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
}
