// Reads where the fake engine's seeded report stands, and what publishes it has seen, through its control server (GET /__test__/state),
// for the golden flow G5 (a published report: read-only, "Edit and republish", the notice choice).
//
//   node scripts/lib/report-state.mjs <control url> <draft|locked|editing> <version|none> [<publishes as JSON>] [<seconds, default 20>]
//       exits 0 when the report is in that state at that version (and, when a list is given, when the publishes the engine saw equal it).
//       It polls up to <seconds>, because the app's request may still be on its way when the flow reaches this step.
//
// A control server that cannot be read is an error, never "nothing happened".

/**
 * @param {unknown} state the JSON of GET /__test__/state
 * @param {{ state: string, version: number | null, publishes?: unknown[] }} expected
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function judgeReport(state, expected) {
  if (typeof state !== 'object' || state === null) return { ok: false, problems: ['the state is not an object'] };
  const { report, publishes, errors } = /** @type {Record<string, any>} */ (state);
  if (typeof report !== 'object' || report === null) return { ok: false, problems: ['the state has no report (is this the fake engine, and was it started with --scenario published?)'] };
  const problems = [];
  if (Array.isArray(errors) && errors.length > 0) problems.push(`the engine logged errors: ${errors.join('; ')}`);
  if (report.state !== expected.state) problems.push(`the report is ${String(report.state)}, expected ${expected.state}`);
  if (report.version !== expected.version) problems.push(`the report is at version ${String(report.version)}, expected ${String(expected.version)}`);
  if (expected.publishes !== undefined) {
    if (!Array.isArray(publishes)) problems.push('the state has no publishes list');
    else if (JSON.stringify(publishes) !== JSON.stringify(expected.publishes)) {
      problems.push(`the publishes the engine saw are ${JSON.stringify(publishes)}, expected ${JSON.stringify(expected.publishes)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function readState(control) {
  const response = await fetch(`${control.replace(/\/$/, '')}/__test__/state`);
  if (!response.ok) throw new Error(`the control server answered ${String(response.status)}`);
  return response.json();
}

async function main(argv) {
  const [control, stateText, versionText, publishesText, secondsText] = argv;
  if (!control || !['draft', 'locked', 'editing'].includes(stateText ?? '') || versionText === undefined) {
    console.error('usage: report-state.mjs <control url> <draft|locked|editing> <version|none> [<publishes JSON>] [<seconds>]');
    return 2;
  }
  const expected = { state: stateText, version: versionText === 'none' ? null : Number(versionText) };
  if (publishesText !== undefined && publishesText !== '') {
    try {
      const parsed = JSON.parse(publishesText);
      if (!Array.isArray(parsed)) throw new Error('not a list');
      expected.publishes = parsed;
    } catch (error) {
      console.error(`the publishes argument is not a JSON list: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const limitMs = Number(secondsText ?? '20') * 1000;
  const started = Date.now();
  for (;;) {
    let verdict;
    try {
      verdict = judgeReport(await readState(control), expected);
    } catch (error) {
      verdict = { ok: false, problems: [`the control server could not be read: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (verdict.ok) {
      console.log(`ok: the report is ${expected.state} at version ${String(expected.version)}${expected.publishes === undefined ? '' : ` and the engine saw ${JSON.stringify(expected.publishes)}`}`);
      return 0;
    }
    if (Date.now() - started >= limitMs) {
      console.error(`::error::report state check failed: ${verdict.problems.join('; ')}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Only when run as a script, not when a test imports judgeReport.
if (process.argv[1]?.endsWith('report-state.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
