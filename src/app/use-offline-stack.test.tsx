// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStackWorld } from './test-support/stack-world';
import { createWorld } from './test-support/world';
import { useOfflineStackLifecycle, type SessionKey, type StackFactory } from './use-offline-stack';

afterEach(cleanup);

const noUnlocks = (): (() => void) => () => undefined;

function Probe({ factory, session, services }: { factory: StackFactory; session: SessionKey | null; services: Awaited<ReturnType<typeof createWorld>>['services'] }) {
  const stack = useOfflineStackLifecycle(services, factory, session, false, noUnlocks);
  return <span data-testid="who">{stack ? `${stack.account.tenantId}/${stack.account.userId}` : 'none'}</span>;
}

const session = (userId: string, tenantId = 'tenant-1'): SessionKey => ({ origin: 'https://oi.example.test', identity: { userId, tenantId, role: 'inspector' } });

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
});
