// d1's engine: a module Worker that loads a decision model and answers the page's requests, off
// the page's main thread.
//
// Load: as `worker.js` loads LFM3, but from d1's runtime builds (`dist/d1/`).
//
// Send: the page's request, its images' RGBA pixels and its clips' 16 kHz samples start answering
// it (`start()`), then one `step()` per macrotask — each image, each clip, each pack of questions
// after the state — each posted to the page, the last with every answer, so a stop request is
// seen between steps: the request is then left unanswered, and the next `start()` replaces it. A
// request sent before the model is ready waits for it.
//
// After the model is loaded nothing else is fetched: answering is entirely local.

import { engine, load, post, ready, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

let stoppedJob = null;

serve({
  load: ({ modelUrl, cacheName, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'd1_runtime',
      cacheName,
      distUrl: new URL('./dist/d1/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  send,
  stop: ({ job }) => (stoppedJob = job),
});

async function send({ job, message, rgba, audio, layout }) {
  await ready;
  const stopped = { type: 'done', job, stopped: true };
  if (stoppedJob === job) return post(stopped);
  const { rt } = engine;
  const plan = JSON.parse(rt.start(message, rgba, audio, layout));
  post({ type: 'started', job, plan });
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) return post({ ...stopped, networkRequests: requestsSinceReady() });
    const progress = JSON.parse(rt.step());
    const reply = { job, ...progress, networkRequests: requestsSinceReady() };
    if (progress.response) return post({ ...reply, type: 'done', stopped: false });
    post({ ...reply, type: 'reply' });
  }
}
