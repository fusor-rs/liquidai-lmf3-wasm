// End-to-end run in headless Chrome, in a fresh profile, of the page holding each model's fixed
// conversations (fixtures/conversations/<model>.json), each reply greedy so that it can be held
// against the reference's.
//
// 1. Open the page on a model (`?id=<model>`, as its picker links it), write the first
//    message, with its images when it has some, and press Send while the model is still loading:
//    it is replied to the moment the model is ready. Check each reply states the facts its turn
//    expects, report how much of the reference's reply it repeats, and check nothing was requested
//    after the model was ready.
// 2. Hold the rest of that conversation, then a new one, and check the same; then the next model.
// 3. A decision model's (d1-*) fixed requests (fixtures/requests/<model>.json): write each
//    request's state and questions, with its images and clips, press Send, and check every
//    answer card shows the decision the reference's answer (fixtures/references/<model>.json)
//    makes, and that nothing was requested after the model was ready.
// 4. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded] [--models lfm3-1.7b,d1-2b]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// Results (JSON, replies, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, log, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';
import { AUDIBLE, agreement, decision, missing, shown, SPEAKS, SPOKEN_RATE } from '../scripts/agreement.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({ models: { type: 'string' } });
const DEADLINE_MS = 30 * 60 * 1000;
// A number's headline shows two decimals.
const HEADLINE_PRECISION = 0.005;

const fixture = (kind, model) => JSON.parse(readFileSync(join(ROOT, `fixtures/${kind}/${model}.json`), 'utf8'));
const fixed = ['conversations', 'requests'].flatMap((kind) => readdirSync(join(ROOT, `fixtures/${kind}`)).map((file) => file.replace(/\.json$/, '')));
const models = values.models?.split(',') ?? fixed;
const decides = (model) => existsSync(join(ROOT, `fixtures/requests/${model}.json`));

// The page's state machine is `main[data-phase]`: idle, replying, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';

/** The last reply and the metric tiles, as the page shows them. */
async function readPage(page) {
  const tiles = ['first', 'speed', 'tokens', 'context', 'requests'];
  const shownTiles = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const reply = page.locator('.message[data-role="model"]').last();
  const thought = reply.locator('.thought');
  return {
    answer: await reply.getAttribute('data-text'),
    reasoning: (await thought.count()) ? await thought.textContent() : null,
    status: await page.textContent('#status'),
    ...Object.fromEntries(tiles.map((id, i) => [id, shownTiles[i]])),
  };
}

/** Sets the page to reply as the fixture's turn asks: in its mode, greedy, thinking or not, its
 * longest reply. A mode's system text is the one the page writes by default. */
async function settle(page, { mode, thinking = false, max_tokens: maxTokens, sampling }) {
  if (mode) await page.selectOption('#mode', mode);
  await page.locator('details.sampling').evaluate((details) => (details.open = true));
  await page.setChecked('#thinking', thinking);
  await page.setChecked('#card-sampling', false);
  await page.fill('#temperature', String(sampling.temperature));
  await page.fill('#top-p', String(sampling.top_p));
  await page.fill('#top-k', String(sampling.top_k));
  await page.fill('#presence-penalty', String(sampling.presence_penalty));
  await page.fill('#max-tokens', String(maxTokens));
}

/** Adds the turn's images to the next message, once the page decoded them. */
async function attach(page, images) {
  if (!images.length) return;
  await page.setInputFiles('#file', images.map((file) => join(ROOT, 'fixtures/media', file)));
  await page.waitForFunction((count) => document.querySelectorAll('canvas[data-image]').length === count, images.length);
}

/** Adds the turn's clips to the next message, once the page decoded them. */
async function play(page, clips) {
  if (!clips.length) return;
  await page.setInputFiles('#audio-file', clips.map((file) => join(ROOT, 'fixtures/media', file)));
  await page.waitForFunction((count) => document.querySelectorAll('.clips li').length === count, clips.length);
}

/** Sends the turn; resolves once the reply is written, with the requests made after the model was
 * ready. */
async function say(page, turn, requestsSeen) {
  await settle(page, turn);
  await attach(page, turn.images ?? []);
  await play(page, turn.audio ?? []);
  await page.fill('#message', turn.text);
  await page.evaluate(() => Object.assign(window.spoken, { samples: 0, energy: 0 }));
  const t0 = Date.now();
  await page.click('#send');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  const mark = requestsSeen.length;
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  const spoken = await page.evaluate(() => window.spoken);
  return { ...(await readPage(page)), spoken, wallMs: Date.now() - t0, fetched: fetched(requestsSeen, mark) };
}

function checkReply(check, { label, turn, reference }, said) {
  const expected = turn.expect ?? [];
  check(said.status === 'Done.', `${label}: ${said.tokens} tokens, the first in ${said.first}, then ${said.speed}; ${said.context} in context; ${(said.wallMs / 1000).toFixed(1)} s in all`);
  const left = missing(expected, said.answer);
  check(left.length === 0, `${label}: ${left.length ? `missing ${left.join(', ')}` : `states ${expected.join(', ')}`}: ${JSON.stringify(said.answer)}`);
  const reply = said.reasoning === null ? said.answer : `${said.reasoning}\n${said.answer}`;
  said.agreement = agreement(shown(reference, turn.thinking), reply);
  log(`     ${label}: ${(said.agreement * 100).toFixed(0)}% of the reference's reply repeated`);
  if (SPEAKS.includes(turn.mode)) {
    const loudness = Math.sqrt(said.spoken.energy / Math.max(said.spoken.samples, 1));
    check(loudness >= AUDIBLE, `${label}: ${(said.spoken.samples / SPOKEN_RATE).toFixed(1)} s spoken, RMS ${loudness.toFixed(3)}`);
  }
  check(said.fetched.length === 0 && said.requests === '0', `${label}: requests while replying: ${said.fetched.length} seen, page counts ${said.requests}`);
}

/** Sends a decision model's request; resolves once it is answered, with every answer card's
 * headline by its question's name and the requests made after the model was ready. */
async function ask(page, { state = '', questions, images = [], clips = [] }, requestsSeen) {
  if (await page.$('#clear:not([disabled])')) await page.click('#clear');
  if (await page.$('#clear-clips:not([disabled])')) await page.click('#clear-clips');
  await attach(page, images);
  await play(page, clips);
  await page.fill('#state', typeof state === 'string' ? state : JSON.stringify(state, null, 2));
  await page.fill('#questions', JSON.stringify(questions, null, 2));
  const t0 = Date.now();
  await page.click('#send');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  const mark = requestsSeen.length;
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  const cards = await page.$$eval('.answer', (found) => found.map((card) => [card.dataset.name, card.querySelector('.headline').textContent]));
  const tiles = ['answer-time', 'input-tokens', 'packs', 'answer-requests'];
  const shownTiles = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  return {
    status: await page.textContent('#status'),
    headlines: Object.fromEntries(cards),
    ...Object.fromEntries(tiles.map((id, i) => [id, shownTiles[i]])),
    wallMs: Date.now() - t0,
    fetched: fetched(requestsSeen, mark),
  };
}

/** Whether a card's headline shows the decision the reference's answer makes: the side of one
 * half of a P(yes), the option, options or level chosen, the value read (its text when it parses
 * to none), whether a box was found, how many boxes. */
function shows(reference, headline) {
  switch (reference.type) {
    case 'noul':
      return Number(headline.replace('P(yes) = ', '')) >= 0.5 === reference.noul >= 0.5;
    case 'choice':
      return headline === (reference.choice ?? (reference.choices.length ? reference.choices.join(', ') : 'None of them'));
    case 'score':
      return headline.startsWith(`${reference.score}: `);
    case 'box':
      return headline === (reference.box ? 'Drawn on the picture' : 'Not in the picture');
    case 'boxes':
      return headline.startsWith(`${reference.boxes.length},`) || headline.startsWith(`At least ${reference.boxes.length},`);
    case 'text':
      return headline === (reference.text === null ? 'Not found' : `“${reference.text}”`);
    default: {
      const value = reference[reference.type];
      if (value === null) return headline === (reference.text === null ? 'Not found' : `“${reference.text}”`);
      return reference.type === 'date' ? headline.startsWith(`${value} · `) : Math.abs(Number(headline.split(' ')[0]) - value) < HEADLINE_PRECISION;
    }
  }
}

function checkAnswers(check, label, references, asked) {
  check(asked.status === 'Done.', `${label}: answered in ${asked['answer-time']}, ${asked['input-tokens']} tokens read in ${asked.packs} packs; ${(asked.wallMs / 1000).toFixed(1)} s in all`);
  for (const [name, reference] of Object.entries(references)) {
    const headline = asked.headlines[name];
    check(headline !== undefined && shows(reference, headline), `${label} ${name}: ${JSON.stringify(headline)} for the reference's ${JSON.stringify(decision(reference))}`);
  }
  check(asked.fetched.length === 0 && asked['answer-requests'] === '0', `${label}: requests while answering: ${asked.fetched.length} seen, page counts ${asked['answer-requests']}`);
}

/** Counts the samples the page plays and their energy, in `window.spoken`. */
function listen() {
  const spoken = (window.spoken = { samples: 0, energy: 0 });
  const copy = AudioBuffer.prototype.copyToChannel;
  AudioBuffer.prototype.copyToChannel = function (source, ...rest) {
    spoken.samples += source.length;
    for (const sample of source) spoken.energy += sample * sample;
    return copy.call(this, source, ...rest);
  };
}

const launch = {
  root: ROOT,
  name: 'lfm3',
  values,
  fields: { cases: {} },
  init: [listen, null],
};
await run(launch, async ({ page, requests: requestsSeen, query, base, runDir, results, check, revisit }) => {
  for (const model of models) {
    if (decides(model)) {
      await page.goto(`${base}/${query}&id=${model}`);
      await page.waitForSelector('main[data-phase]');
      const references = fixture('references', model);
      for (const [name, request] of Object.entries(fixture('requests', model))) {
        const asked = await ask(page, request, requestsSeen);
        results.runtime ??= await page.textContent('#runtime');
        checkAnswers(check, `${model} ${name}`, references[name], asked);
        results.cases[`${model} ${name}`] = { answers: asked['answer-time'], tokens: asked['input-tokens'], packs: asked.packs, wallMs: asked.wallMs };
        writeFileSync(join(runDir, `${STAMP}-${model}-${name}.txt`), `${Object.entries(asked.headlines).map(([question, headline]) => `${question}: ${headline}`).join('\n')}\n`);
        await page.screenshot({ path: join(runDir, `${STAMP}-${model}-${name}.png`), fullPage: true });
      }
      continue;
    }
    const conversations = fixture('conversations', model);
    const references = fixture('references', model);
    await page.goto(`${base}/${query}&id=${model}`);
    await page.waitForSelector('main[data-phase]');
    results.sentWhileLoading ??= (await page.getAttribute('main', 'data-loaded')) !== 'true';
    log(`${model}: page open, the model ${(await page.getAttribute('main', 'data-loaded')) === 'true' ? 'loaded' : 'still loading'}`);
    for (const [name, { turns }] of Object.entries(conversations)) {
      if (await page.$('.message')) await page.click('#reset');
      const said = [];
      for (const [index, turn] of turns.entries()) {
        said.push(await say(page, turn, requestsSeen));
        results.runtime ??= await page.textContent('#runtime');
        checkReply(check, { label: `${model} ${name} ${index}`, turn, reference: references[name][index] }, said[index]);
      }
      results.cases[`${model} ${name}`] = { first: said[0].first, speed: said.at(-1).speed, wallMs: said[0].wallMs, turns: said };
      const replies = said.map(({ reasoning, answer }) => (reasoning === null ? answer : `${reasoning}\n${answer}`));
      writeFileSync(join(runDir, `${STAMP}-${model}-${name}.txt`), `${replies.join('\n\n---\n\n')}\n`);
      await page.screenshot({ path: join(runDir, `${STAMP}-${model}-${name}.png`), fullPage: true });
    }
  }

  await revisit(loadedOrBroken, DEADLINE_MS);
});
