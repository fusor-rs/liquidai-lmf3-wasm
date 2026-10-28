// A reply against the reference's, for the smoke and e2e checks: the facts its turn expects
// (`expect` in fixtures/conversations/<model>.json), which its answer must state, and how much
// of the reference's greedy reply it repeats before the two part (quantized weights flip near
// ties, after which a greedy reply goes its own way); and a decision model's answers against the
// reference's decisions.

const THINK_END = '</think>';
// The modes whose replies speak, the rate they speak at, and the RMS below which a spoken reply
// is silence.
export const SPEAKS = ['speech', 'interleaved'];
export const SPOKEN_RATE = 24_000;
export const AUDIBLE = 0.01;

/** The expected facts `answer` leaves out, case aside. */
export function missing(expected, answer) {
  const text = answer.toLowerCase();
  return expected.filter((fact) => !text.includes(fact.toLowerCase()));
}

/** A reply as the runtime and the page show it: its reasoning (when its turn thinks), then its answer. */
export function shown(reply, thinking) {
  const end = reply.lastIndexOf(THINK_END);
  if (end >= 0) return [reply.slice(0, end).trim(), reply.slice(end + THINK_END.length).replace(/^\n+/, '')].join('\n');
  return thinking ? `${reply.trim()}\n` : reply;
}

/** The share of `reference` that `reply` repeats from its start, character by character. */
export function agreement(reference, reply) {
  let same = 0;
  while (same < reference.length && reference[same] === reply[same]) same++;
  return reference.length ? same / reference.length : 1;
}

/** A decision model's answer as the checks hold it to the reference's: the side of one half of a
 * P(yes) or of a box's presence, the option, options or level chosen, the value read, how many
 * boxes. */
export function decision(answer) {
  switch (answer.type) {
    case 'noul':
      return answer.noul >= 0.5;
    case 'choice':
      return answer.choice ?? answer.choices;
    case 'box':
      return answer.box !== null;
    case 'boxes':
      return answer.boxes.length;
    default:
      return answer[answer.type];
  }
}
