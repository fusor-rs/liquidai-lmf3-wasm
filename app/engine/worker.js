// The engine's home: a module Worker that loads the model and holds the conversation, off the
// page's main thread.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Send: the page's message, its images' RGBA pixels and its clips' 16 kHz samples start the
// conversation's next turn (`start()`), then one `step()` per macrotask — each image, each clip,
// the whole conversation's prompt, then one row of the reply at a time, a token or a spoken frame —
// each posted to the page as the whole reply so far, with the samples it spoke since, so a stop
// request is seen between steps. A message sent before the model is ready waits for it. Reset
// forgets the conversation.
//
// After the model is loaded nothing else is fetched: replying is entirely local.

import { engine, load, post, ready, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

let stoppedJob = null;

serve({
  load: ({ modelUrl, cacheName, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'lfm3_runtime',
      cacheName,
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  send,
  stop: ({ job }) => (stoppedJob = job),
  reset: async () => {
    await ready;
    engine.rt.reset();
  },
});

async function send({ job, message, rgba, audio, layout }) {
  await ready;
  const stopped = { type: 'done', job, stopped: true };
  if (stoppedJob === job) return post(stopped);
  const { rt } = engine;
  const plan = JSON.parse(rt.start(message, rgba, audio, layout));
  post({ type: 'started', job, plan });
  const speak = () => {
    const samples = rt.speech();
    if (samples.length) post({ type: 'speech', job, samples }, [samples.buffer]);
  };
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) {
      rt.cancel();
      speak();
      return post({ ...stopped, networkRequests: requestsSinceReady() });
    }
    const progress = JSON.parse(rt.step());
    speak();
    const reply = { job, ...progress, networkRequests: requestsSinceReady() };
    if (progress.done) return post({ ...reply, type: 'done', stopped: false });
    post({ ...reply, type: 'reply' });
  }
}
