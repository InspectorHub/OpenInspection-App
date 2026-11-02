// Reads what the fake engine (e2e/fake-engine) has seen, through its control server (GET /__test__/state), for the Android golden flow G3.
//
//   node scripts/lib/engine-state.mjs <control url> none-uploaded
//       exits 0 when NO upload has completed yet (the engine was off while the photo was taken) and the engine logged no error.
//   node scripts/lib/engine-state.mjs <control url> one-uploaded <seconds> [settle seconds, default 15]
//       polls until exactly one upload has completed, once, with nothing still in flight; then keeps watching for the settle time, because
//       a second copy sent a few seconds after the first (a retry after a restart) must not slip past a check that stopped at the first
//       success. Exits 1 when that did not happen within <seconds>, when a second copy completed or started, or the engine logged an error.
//
// A control server that cannot be read is an error, never "nothing uploaded": the first check must not pass on a dead engine.

/**
 * @param {unknown} state the JSON of GET /__test__/state
 * @param {'none-uploaded' | 'one-uploaded'} expectation
 * @returns {{ ok: boolean, done: boolean, problems: string[] }} done = nothing more can change the answer (stop polling)
 */
export function judgeState(state, expectation) {
  const problems = [];
  if (typeof state !== 'object' || state === null) return { ok: false, done: true, problems: ['the state is not an object'] };
  const { completedCounts, errors } = /** @type {Record<string, unknown>} */ (state);
  if (typeof completedCounts !== 'object' || completedCounts === null || Array.isArray(completedCounts)) {
    return { ok: false, done: true, problems: ['the state has no completedCounts (is this the fake engine?)'] };
  }
  if (!Array.isArray(errors)) return { ok: false, done: true, problems: ['the state has no errors list (is this the fake engine?)'] };
  const counts = Object.entries(/** @type {Record<string, unknown>} */ (completedCounts));
  if (errors.length > 0) problems.push(`the engine logged errors: ${errors.join('; ')}`);
  if (expectation === 'none-uploaded') {
    if (counts.length > 0) problems.push(`an upload completed while the engine was meant to be off: ${counts.map(([key]) => key).join(', ')}`);
    return { ok: problems.length === 0, done: true, problems };
  }
  const twice = counts.filter(([, count]) => count !== 1);
  if (twice.length > 0) problems.push(`an upload completed more than once: ${twice.map(([key, count]) => `${key} x${String(count)}`).join(', ')}`);
  if (counts.length > 1) problems.push(`more than one upload completed: ${counts.map(([key]) => key).join(', ')}`);
  if (problems.length > 0) return { ok: false, done: true, problems };
  if (counts.length === 0) return { ok: false, done: false, problems: ['no upload has completed yet'] };
  const inFlight = /** @type {Record<string, unknown>} */ (state).activeUploadCount;
  if (typeof inFlight === 'number' && inFlight > 0) return { ok: false, done: false, problems: [`${String(inFlight)} upload(s) still in flight`] };
  return { ok: true, done: true, problems: [] };
}

async function readState(control) {
  const response = await fetch(`${control.replace(/\/$/, '')}/__test__/state`);
  if (!response.ok) throw new Error(`the control server answered ${String(response.status)}`);
  return response.json();
}

async function main(argv) {
  const [control, expectation, secondsText, settleText] = argv;
  if (!control || (expectation !== 'none-uploaded' && expectation !== 'one-uploaded')) {
    console.error('usage: engine-state.mjs <control url> none-uploaded | one-uploaded <seconds> [settle seconds]');
    return 2;
  }
  const limitMs = Number(secondsText ?? '0') * 1000;
  const settleMs = expectation === 'one-uploaded' ? Number(settleText ?? '15') * 1000 : 0;
  const started = Date.now();
  let okSince = null;
  for (;;) {
    let verdict;
    try {
      verdict = judgeState(await readState(control), expectation);
    } catch (error) {
      verdict = { ok: false, done: false, problems: [`the control server could not be read: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (verdict.ok) {
      okSince ??= Date.now();
      if (Date.now() - okSince >= settleMs) {
        console.log(`ok: ${expectation}${settleMs > 0 ? ` (and it stayed that way for ${String(settleMs / 1000)} s)` : ''}`);
        return 0;
      }
    } else if (okSince !== null) {
      // It was fine, and then it was not: a second copy arrived (or the control server went away) inside the settle time.
      console.error(`::error::${expectation} failed after it had been met: ${verdict.problems.join('; ')}`);
      return 1;
    } else if (verdict.done || Date.now() - started >= limitMs) {
      console.error(`::error::${expectation} failed: ${verdict.problems.join('; ')}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Only when run as a script, not when a test imports judgeState.
if (process.argv[1]?.endsWith('engine-state.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
