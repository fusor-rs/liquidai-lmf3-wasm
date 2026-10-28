import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool); for a model that
// reads images, the images: chosen, dropped or pasted, each decoded here to RGBA pixels and drawn
// as a thumbnail; for a model that hears, the clips: chosen or recorded from the microphone (the
// page asks for it, the engine never sees it), each decoded here to 16 kHz mono samples; and the
// speech a reply speaks, played here as it streams in. It hands the engine the message
// `src/app.rs` composed when Send is pressed, with the images and clips added since the last,
// measures each reply and reports back with `engine` events. A decision model has an engine worker
// of its own (`engine/d1.js`): it takes the request `src/app.rs` composed, with every image and
// clip, which stay for the next request, and reports its answers.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The models of the collection the page runs, in the picker's order; a model joins the page as one
// entry here and one name in the justfile's `models`. `?id=<id>` picks one, the first unless
// asked. Its bundle is served next to the page (`just serve` mounts dist/model there), or, on a
// Hugging Face Space, which holds at most 1 GB, from the model repo fusorlabs/<id>-web (`just
// deploy-model`); `?model=<url>` loads another one, `?build=web-single` pins a runtime build.
// Each one's `name` is its repository's under LiquidAI on Hugging Face; a decision model `decides`.
const MODELS = [
  { id: 'lfm3-1.7b', name: 'LFM3-1.7B', reads: 'text', images: false, audio: false },
  { id: 'lfm3-vl-2b', name: 'LFM3-VL-2B', reads: 'text and images', images: true, audio: false },
  { id: 'lfm3-audio-2b', name: 'LFM3-Audio-2B', reads: 'text and speech', images: false, audio: true },
  { id: 'lfm3-omni-2b', name: 'LFM3-Omni-2B', reads: 'text, images and speech', images: true, audio: true },
  { id: 'd1-2b', name: 'd1-2B', reads: 'decisions on text and images', images: true, audio: false, decides: true },
  { id: 'd1-omni-2b', name: 'd1-Omni-2B', reads: 'decisions on text, images and speech', images: true, audio: true, decides: true },
];
// The rate the engine hears clips at, and speaks at.
const HEARD_RATE = 16_000;
const SPOKEN_RATE = 24_000;
const MODEL = MODELS.find((model) => model.id === params.get('id')) ?? MODELS[0];
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? `https://huggingface.co/fusorlabs/${MODEL.id}-web/resolve/main/` : `model/${MODEL.id}/`;
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
// The status of a step, by its stage: a reply's past the first, each of a decision's.
const STATUS = { see: 'Looking at the images…', hear: 'Listening…', speak: 'Speaking…', read: 'Reading the state and the questions…' };

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL(MODEL.decides ? 'engine/d1.js' : 'engine/worker.js', document.baseURI), { type: 'module', name: 'lfm3-engine' });
  const computePool = new ComputePool(crash);
  let build = null;
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  let images = [];
  let added = 0;
  let clips = [];
  let addedClips = 0;
  let recording = null;
  let speaker = null;
  let playAt = 0;
  let readyAt = Infinity;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => (build = message),
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: ({ ms, cache, total }) => {
      loaded = true;
      readyAt = performance.now();
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', loaded: loadedInfo });
    },
    started: (message) => {
      if (message.job !== job?.id) return;
      job.plan = message.plan;
      const status = message.plan.images.length ? 'Looking at the images…' : message.plan.clips.length ? 'Listening…' : 'Reading the conversation…';
      report({ type: 'reply', status, reasoning: null, answer: '', metrics: metrics() });
    },
    reply: (message) => {
      if (message.job !== job?.id) return;
      reply(message, STATUS[message.stage] ?? 'Writing…');
    },
    speech: (message) => {
      if (message.job === job?.id) play(message.samples);
    },
    done: (message) => {
      if (message.job !== job?.id) return;
      if (!message.stopped) reply(message, 'Done.');
      report({ type: 'done', status: message.stopped ? 'Stopped.' : 'Done.', metrics: metrics(message) });
      job = null;
    },
    error: ({ message }) => {
      if (!loaded) return fail(message);
      job = null;
      report({ type: 'error', message });
    },
    fatal: ({ message }) => fail(message),
  };

  // A decision model's job instead: each image, each clip, then each pack of questions, the last
  // with every answer.
  const deciding = {
    started: (message) => {
      if (message.job !== job?.id) return;
      job.plan = message.plan;
      report({ type: 'deciding', status: STATUS[nextStage(0)] });
    },
    reply: (message) => {
      if (message.job === job?.id) report({ type: 'deciding', status: STATUS[nextStage(message.done)] });
    },
    done: (message) => {
      if (message.job !== job?.id) return;
      // A stopped request has no response.
      const { answers, usage } = message.response ?? { answers: {}, usage: { input_tokens: 0 } };
      report({
        type: 'decided',
        status: message.stopped ? 'Stopped.' : 'Done.',
        answers: Object.entries(answers).map(([name, answer]) => ({ name, answer })),
        metrics: {
          answer_ms: message.stopped ? null : performance.now() - job.t0,
          input_tokens: usage.input_tokens,
          packs: job.plan?.packs.length ?? 0,
          requests: requests(message),
        },
      });
      job = null;
    },
  };
  const routes = MODEL.decides ? { ...handlers, ...deciding } : handlers;

  engine.onmessage = ({ data }) => {
    if (!broken) routes[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  // Each model caches its parts apart: loading one evicts the cached parts its manifest doesn't list.
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, cacheName: `${MODEL.id}-parts`, threads: THREADS, build: params.get('build') });
  report({ type: 'models', models: MODELS.map((model) => ({ ...model, current: model === MODEL })) });

  /** The reply so far, as the step left it. */
  function reply(message, status) {
    const now = performance.now();
    if (message.tokens > 0) job.firstAt ??= now;
    job.lastAt = now;
    job.tokens = message.tokens;
    report({ type: 'reply', status, reasoning: message.reasoning, answer: message.answer, metrics: metrics(message) });
  }

  /** Decodes the image `files` to RGBA pixels as stored, and adds them to the next message. */
  async function add(files) {
    if (job || !MODEL.images) return;
    for (const file of files) {
      try {
        images.push({ index: added++, name: file.name || 'pasted image', ...(await decodeImage(file)) });
      } catch (error) {
        report({ type: 'error', message: `could not read ${file.name || 'the image'} (${error?.message ?? error})` });
      }
    }
    listImages();
  }

  function listImages() {
    report({ type: 'images', images: images.map(({ index, name, width, height }) => ({ index, name, width, height })) });
  }

  /** Decodes the audio `files` (or recordings) to 16 kHz mono samples, and adds them to the next message. */
  async function addClips(files) {
    if (job || !MODEL.audio) return;
    for (const file of files) {
      try {
        clips.push({ index: addedClips++, name: file.name || 'recording', samples: await decodeClip(file) });
      } catch (error) {
        report({ type: 'error', message: `could not read ${file.name || 'the recording'} (${error?.message ?? error})` });
      }
    }
    listClips();
  }

  function listClips() {
    report({ type: 'clips', clips: clips.map(({ index, name, samples }) => ({ index, name, seconds: samples.length / HEARD_RATE })) });
  }

  /** Starts recording from the microphone, or stops and adds the recording. */
  async function record() {
    if (recording) return recording.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recording = new MediaRecorder(stream);
      recording.ondataavailable = ({ data }) => chunks.push(data);
      recording.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        recording = null;
        report({ type: 'recording', active: false });
        addClips([new Blob(chunks, { type: chunks[0]?.type })]);
      };
      recording.start();
      report({ type: 'recording', active: true });
    } catch (error) {
      report({ type: 'error', message: `could not record (${error?.message ?? error})` });
    }
  }

  function dropClips() {
    clips = [];
    listClips();
  }

  /** Plays 24 kHz samples the reply spoke, right after those before them. */
  function play(samples) {
    const buffer = speaker.createBuffer(1, samples.length, SPOKEN_RATE);
    buffer.copyToChannel(samples, 0);
    const source = speaker.createBufferSource();
    source.buffer = buffer;
    source.connect(speaker.destination);
    playAt = Math.max(playAt, speaker.currentTime);
    source.start(playAt);
    playAt += buffer.duration;
  }

  /** Draws each image into its thumbnail, `data-height` pixels tall at most, once the page has drawn the canvas for it. */
  function drawThumbnails() {
    for (const canvas of root.querySelectorAll('canvas[data-image]')) {
      const image = images.find((entry) => String(entry.index) === canvas.dataset.image);
      if (!image || canvas.dataset.drawn === canvas.dataset.image) continue;
      canvas.dataset.drawn = canvas.dataset.image;
      const scale = Math.min(1, (Number(canvas.dataset.height ?? 96) * devicePixelRatio) / image.height);
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);
    }
  }

  /** Sends the message `src/app.rs` composed, with a seed of its own, or its request, and the images and clips added for it. */
  function send() {
    job = { id: ++jobs, t0: performance.now(), firstAt: null, lastAt: null, plan: null, tokens: 0 };
    // Send is a click, which lets the page start playing speech.
    speaker ??= new AudioContext({ sampleRate: SPOKEN_RATE });
    speaker.resume();
    const [seed] = crypto.getRandomValues(new Uint32Array(1));
    const message = MODEL.decides ? inputs.message.get() : JSON.stringify({ ...JSON.parse(inputs.message.get()), seed });
    const rgba = new Uint8Array(images.reduce((sum, image) => sum + image.rgba.length, 0));
    let at = 0;
    for (const image of images) {
      rgba.set(image.rgba, at);
      at += image.rgba.length;
    }
    const audio = new Float32Array(clips.reduce((sum, clip) => sum + clip.samples.length, 0));
    at = 0;
    for (const clip of clips) {
      audio.set(clip.samples, at);
      at += clip.samples.length;
    }
    const layout = JSON.stringify({ images: images.map(({ width, height }) => [width, height]), clips: clips.map(({ samples }) => samples.length) });
    engine.postMessage({ type: 'send', job: job.id, message, rgba, audio, layout }, [rgba.buffer, audio.buffer]);
    if (MODEL.decides) return;
    clear();
    dropClips();
  }

  function clear() {
    for (const image of images) image.bitmap.close();
    images = [];
    listImages();
  }

  function stop() {
    if (job) engine.postMessage({ type: 'stop', job: job.id });
  }

  /** A new conversation: the engine forgets the last. */
  function reset() {
    engine.postMessage({ type: 'reset' });
  }

  /** The stage of a decision's step after `done` steps: its images, then its clips, then its packs. */
  function nextStage(done) {
    const { images, clips } = job.plan;
    if (done < images.length) return 'see';
    return done < images.length + clips.length ? 'hear' : 'read';
  }

  /** The network requests the page and the engine made since the model was ready. */
  function requests(message) {
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    return ownRequests + (message.networkRequests ?? 0);
  }

  function metrics(message = {}) {
    const tokens = job?.tokens ?? 0;
    const promptTokens = job?.plan?.prompt_tokens ?? 0;
    return {
      first_ms: job?.firstAt ? job.firstAt - job.t0 : null,
      tokens,
      writing_ms: job?.firstAt ? job.lastAt - job.firstAt : 0,
      context_tokens: promptTokens + tokens,
      prompt_tokens: promptTokens,
      requests: requests(message),
    };
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    engine.terminate();
    computePool.terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  // The image and audio inputs appear only for a model that reads images or hears, so their changes are caught here.
  const onChange = (event) => {
    const pick = { file: add, 'audio-file': addClips }[event.target.id];
    if (!pick) return;
    pick([...event.target.files]);
    event.target.value = '';
  };
  const isImage = (type) => type.startsWith('image/');
  const onDrop = (event) => {
    event.preventDefault();
    add([...(event.dataTransfer?.files ?? [])].filter((entry) => isImage(entry.type)));
  };
  const onDragOver = (event) => event.preventDefault();
  const onPaste = (event) => {
    const items = [...(event.clipboardData?.items ?? [])].filter((entry) => isImage(entry.type));
    if (items.length) add(items.map((item) => item.getAsFile()));
  };
  const thumbnails = new MutationObserver(drawThumbnails);
  thumbnails.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-image'] });
  root.addEventListener('change', onChange);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragover', onDragOver);
  document.addEventListener('paste', onPaste);
  onCleanup(onClicks(inputs.sends, send));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(onClicks(inputs.resets, reset));
  onCleanup(onClicks(inputs.clears, clear));
  onCleanup(onClicks(inputs.records, record));
  onCleanup(onClicks(inputs.drops, dropClips));
  onCleanup(() => {
    root.removeEventListener('change', onChange);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('dragover', onDragOver);
    document.removeEventListener('paste', onPaste);
    thumbnails.disconnect();
    recording?.stop();
    speaker?.close();
    engine.terminate();
    computePool.terminate();
  });
}

/** An image's RGBA pixels as stored (no color conversion), and its bitmap. */
async function decodeImage(file) {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
  return { width: bitmap.width, height: bitmap.height, rgba: data, bitmap };
}

/** A clip's samples at 16 kHz, its channels averaged: decoding into a 16 kHz context resamples it. */
async function decodeClip(file) {
  const context = new OfflineAudioContext(1, 1, HEARD_RATE);
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const values = decoded.getChannelData(channel);
    for (let at = 0; at < samples.length; at++) samples[at] += values[at] / decoded.numberOfChannels;
  }
  return samples;
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
