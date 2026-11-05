// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_REPORT_LOCK, type ReportLock } from '../field/editor-data';
import { EDITING_AGAIN_TEXT, EDIT_AND_REPUBLISH_LABEL, OFFLINE_REOPEN_TEXT, PUBLISHED_ELSEWHERE_TEXT, PUBLISHED_TEXT, PUBLISH_UPDATE_LABEL, PublishedReportBanner } from './PublishedReportBanner';

afterEach(cleanup);

const LOCKED: ReportLock = { contentLocked: true, editingAgain: false, publishedVersionNumber: 3 };
const AGAIN: ReportLock = { contentLocked: false, editingAgain: true, publishedVersionNumber: 3 };

function show(over: Partial<Parameters<typeof PublishedReportBanner>[0]> = {}) {
  const onEditAgain = vi.fn();
  const onPublish = vi.fn();
  const view = render(<PublishedReportBanner lock={LOCKED} serverLocked={false} online busy={false} error={null} onEditAgain={onEditAgain} onPublish={onPublish} {...over} />);
  return { view, onEditAgain, onPublish };
}

describe('the published-report banner', () => {
  it('a published report says so with its version and offers Edit and republish', async () => {
    const { onEditAgain, onPublish } = show();
    expect(screen.getByText(PUBLISHED_TEXT(3))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: EDIT_AND_REPUBLISH_LABEL }));
    expect(onEditAgain).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: PUBLISH_UPDATE_LABEL })).toBeNull();
  });

  it('without a known version the sentence still reads whole', () => {
    show({ lock: { ...LOCKED, publishedVersionNumber: null } });
    expect(screen.getByText(PUBLISHED_TEXT(null))).toBeInTheDocument();
  });

  it('offline the button is disabled and the reason is written out; nothing is sent', async () => {
    const { onEditAgain } = show({ online: false });
    const button = screen.getByRole('button', { name: EDIT_AND_REPUBLISH_LABEL });
    expect(button).toBeDisabled();
    expect(screen.getByText(OFFLINE_REOPEN_TEXT)).toBeInTheDocument();
    await userEvent.click(button);
    expect(onEditAgain).not.toHaveBeenCalled();
  });

  it('while the request is in flight the button is busy and cannot be pressed twice', async () => {
    const { onEditAgain } = show({ busy: true });
    const button = screen.getByRole('button', { name: EDIT_AND_REPUBLISH_LABEL });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onEditAgain).not.toHaveBeenCalled();
  });

  it('a report reopened for editing says clients still see the last version and offers Publish update', async () => {
    const { onPublish, onEditAgain } = show({ lock: AGAIN });
    expect(screen.getByText(EDITING_AGAIN_TEXT(3))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: EDIT_AND_REPUBLISH_LABEL })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: PUBLISH_UPDATE_LABEL }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onEditAgain).not.toHaveBeenCalled();
  });

  it('a report published from another device while the editor was open gets the same way back', () => {
    show({ lock: AGAIN, serverLocked: true });
    expect(screen.getByText(PUBLISHED_ELSEWHERE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: EDIT_AND_REPUBLISH_LABEL })).toBeEnabled();
  });

  it('an ordinary draft shows nothing at all; a failed attempt shows its sentence as an alert', () => {
    const { view } = show({ lock: NO_REPORT_LOCK });
    expect(view.container).toBeEmptyDOMElement();
    cleanup();
    show({ lock: NO_REPORT_LOCK, error: 'Could not open the report for editing. Try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open the report for editing');
  });

  it('a failed attempt on a locked report keeps the button and shows the sentence beside it', () => {
    show({ error: 'Could not open the report for editing. Try again.' });
    expect(screen.getByRole('button', { name: EDIT_AND_REPUBLISH_LABEL })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open');
  });
});
