import { describe, expect, it } from 'vitest';
import { LOCK_CHECK_INTERVAL_MS } from '../../offline/lock-monitor';
import { createDiagRig } from '../test-support';
import { lockClock, lockSimulate } from './lock-clock';

async function storedMaxSeen(rig: Awaited<ReturnType<typeof createDiagRig>>): Promise<number> {
  const rows = await rig.services.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'max_seen_time'");
  return Number(rows[0]?.value);
}

describe('lock-clock', () => {
  it('passes for a signed-in device whose latest time seen is recent, and only reads', async () => {
    const rig = await createDiagRig();
    const before = await storedMaxSeen(rig);
    const result = await lockClock.run(rig.ctx);
    expect(result).toMatchObject({ id: 'lock-clock', ok: true });
    expect(result.detail).toContain(`now=${String(rig.world.clock.now())}`);
    expect(result.detail).toContain(`max_seen=${String(before)}`);
    expect(result.detail).toContain('read_only_result=unlocked monitor_persisted=yes');
    expect(result.detail).toContain('manual=change_emulator_date_then_press_simulate');
    expect(await storedMaxSeen(rig)).toBe(before);
  });

  it('control: fails when the monitor has not persisted the time for longer than two intervals', async () => {
    const rig = await createDiagRig();
    rig.world.clock.advance(3 * LOCK_CHECK_INTERVAL_MS);
    const result = await lockClock.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('monitor_persisted=no');
  });

  it('on the setup screen there is no monitor, and that is not a failure', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const result = await lockClock.run(rig.ctx);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('max_seen=none');
    expect(result.detail).toContain('monitor_persisted=no');
  });

  it('reports the clock reason when the device clock was wound back', async () => {
    const rig = await createDiagRig();
    rig.world.clock.advance(-24 * 60 * 60 * 1000);
    const result = await lockClock.run(rig.ctx);
    expect(result.detail).toContain('read_only_result=clock');
  });
});

describe('lock-simulate', () => {
  it('runs the monitor evaluation and raises the stored latest time seen', async () => {
    const rig = await createDiagRig();
    rig.world.clock.advance(10 * 60 * 1000);
    const result = await lockSimulate.run(rig.ctx);
    expect(result).toMatchObject({ id: 'lock-simulate', ok: true });
    expect(result.detail).toBe(`now=${String(rig.world.clock.now())} result=unlocked max_seen_after=${String(rig.world.clock.now())}`);
    expect(await storedMaxSeen(rig)).toBe(rig.world.clock.now());
  });

  it('control: after the clock is wound back the same button reports the clock lock and keeps the higher time', async () => {
    const rig = await createDiagRig();
    const high = rig.world.clock.now() + 24 * 60 * 60 * 1000;
    rig.world.clock.set(high);
    await lockSimulate.run(rig.ctx);
    rig.world.clock.set(high - 24 * 60 * 60 * 1000);
    const result = await lockSimulate.run(rig.ctx);
    expect(result.detail).toContain('result=locked_clock');
    expect(result.detail).toContain(`max_seen_after=${String(high)}`);
  });
});
