import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DraftComment } from './DraftComment.js';
import { draftKey, useDraftStore, type Draft } from '../../state/draft.js';

const draft: Draft = { file: 'src/auth.ts', side: 'new', line: 12, body: 'extract a hook' };
const key = draftKey(draft.file, draft.side, draft.line);

beforeEach(() => {
  useDraftStore.getState().reset();
  useDraftStore.getState().setComment(draft.file, draft.side, draft.line, draft.body);
});

describe('DraftComment', () => {
  it('rests as a card, not as an open editor', () => {
    render(<DraftComment draft={draft} />);

    expect(screen.getByText('extract a hook')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens the editor on Edit, prefilled with what was written', async () => {
    render(<DraftComment draft={draft} />);

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));

    expect(screen.getByRole('textbox')).toHaveValue('extract a hook');
  });

  it('goes back to the card once the edit is saved', async () => {
    render(<DraftComment draft={draft} />);

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'use the hook instead');
    await userEvent.click(screen.getByRole('button', { name: /save comment/i }));

    expect(useDraftStore.getState().comments[key]?.body).toBe('use the hook instead');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('goes back to the card on cancel, keeping the comment as it was', async () => {
    render(<DraftComment draft={draft} />);

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    await userEvent.type(screen.getByRole('textbox'), ' — or not');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(useDraftStore.getState().comments[key]?.body).toBe('extract a hook');
  });

  it('drops the comment on Delete', async () => {
    render(<DraftComment draft={draft} />);

    await userEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(useDraftStore.getState().comments).toEqual({});
  });
});
