// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStackWorld } from './test-support/stack-world';
import { createWorld } from './test-support/world';
import type { StackDiagnostic } from './offline-stack';
import { useOfflineStackLifecycle, type SessionKey, type StackFactory } from './use-offline-stack';

afterEach(cleanup);

const noUnlocks = (): (() => void) => () => undefined;

function Probe({ factory, session, services, onDiagnostic }: { factory: StackFactory; session: SessionKey | null; services: Awaited<ReturnType<typeof createWorld>>['services']; onDiagnostic?: (code: StackDiagnostic) => void }) {
  const stack = useOfflineStackLifecycle(services, factory, session, false, noUnlocks, onDiagnostic);
  return <span data-testid="who">{stack ? `${stack.account.tenantId}/${stack.account.userId}` : 'none'}</span>;
}

const session = (userId: string, tenantId = 'tenant-1', origin = 'https://oi.example.test'): SessionKey => ({ origin, identity: { userId, tenantId, role: 'inspector' } });

async function setup() {
  const stackWorld = await createStackWorld();
  const { services } = await createWorld();
  const stacks: ReturnType<typeof stackWorld.make>[] = [];
  const factory = vi.fn<StackFactory>(({ identity }) => {
    const stack = stackWorld.make({ identity });
    stacks.push(stack);
    return stack;
  });
  return { stackWorld, services, stacks, factory };
}

describe('useOfflineStackLifecycle', () => {
  it('StrictMode mounts, cleans up and mounts again, and one stack is built and kept', async () => {
    const { services, stacks, factory } = await setup();
    render(
      <StrictMode>
        <Probe factory={factory} session={session('alice')} services={services} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    await stacks[0]?.settled();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stacks[0]?.isStopped()).toBe(false);
  });

  it('a different account builds a new stack and stops the old one', async () => {
    const { services, stacks, factory } = await setup();
    const view = render(<Probe factory={factory} session={session('alice')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    view.rerender(<Probe factory={factory} session={session('bob')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/bob'));
    expect(factory).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
    expect(stacks[1]?.isStopped()).toBe(false);
  });

  it('the same account re-rendered keeps its stack', async () => {
    const { services, stacks, factory } = await setup();
    const view = render(<Probe factory={factory} session={session('alice')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    view.rerender(<Probe factory={factory} session={session('alice')} services={services} />);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stacks[0]?.isStopped()).toBe(false);
  });

  it('no session means no stack, and leaving one stops it', async () => {
    const { services, stacks, factory } = await setup();
    const view = render(<Probe factory={factory} session={null} services={services} />);
    expect(screen.getByTestId('who')).toHaveTextContent('none');
    expect(factory).not.toHaveBeenCalled();
    view.rerender(<Probe factory={factory} session={session('alice')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    view.rerender(<Probe factory={factory} session={null} services={services} />);
    expect(screen.getByTestId('who')).toHaveTextContent('none');
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
  });

  it('unmounting stops it', async () => {
    const { services, stacks, factory } = await setup();
    const view = render(<Probe factory={factory} session={session('alice')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    view.unmount();
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
  });

  it.each([
    ['another server', session('alice', 'tenant-1', 'https://other.example.test')],
    ['another company', session('alice', 'tenant-2')],
  ])('the same user id on %s is another session: a new stack, and the old one is stopped', async (_name, next) => {
    const { services, stacks, factory } = await setup();
    const view = render(<Probe factory={factory} session={session('alice')} services={services} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/alice'));
    view.rerender(<Probe factory={factory} session={next} services={services} />);
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
    expect(factory.mock.calls[1]?.[0].origin).toBe(next.origin);
    expect(factory.mock.calls[1]?.[0].identity.tenantId).toBe(next.identity.tenantId);
    expect(stacks[1]?.isStopped()).toBe(false);
  });

  it('a factory that throws leaves the app without a stack and reports a fixed code; the next session still gets one', async () => {
    const { services, stacks, factory } = await setup();
    const codes: StackDiagnostic[] = [];
    let broken = true;
    const flaky = vi.fn<StackFactory>((input) => {
      if (broken) throw new Error('constructor failed for /secret/path');
      return factory(input);
    });
    const view = render(<Probe factory={flaky} session={session('alice')} services={services} onDiagnostic={(code) => codes.push(code)} />);
    await waitFor(() => expect(codes).toEqual(['factory_failed']));
    expect(screen.getByTestId('who')).toHaveTextContent('none');
    broken = false;
    view.rerender(<Probe factory={flaky} session={session('bob')} services={services} onDiagnostic={(code) => codes.push(code)} />);
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('tenant-1/bob'));
    expect(stacks).toHaveLength(1);
    expect(codes).toEqual(['factory_failed']);
  });
});
