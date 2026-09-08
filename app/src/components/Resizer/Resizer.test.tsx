import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Resizer } from './Resizer.js';

/**
 * jsdom implements no PointerEvent, so the generic Event that `fireEvent.pointerDown`
 * falls back to carries neither `button` nor `clientX` — the only two fields the
 * drag reads. A MouseEvent carries both, and React dispatches on the event's type
 * name rather than its class, so this is what a pointer event looks like here.
 */
function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, ...init });
}

function setup(width = 280) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(<Resizer width={width} min={160} max={640} onChange={onChange} onReset={onReset} />);
  return { onChange, onReset, handle: screen.getByRole('separator') };
}

describe('Resizer', () => {
  it('describes itself as a vertical splitter with its current width', () => {
    const { handle } = setup(320);

    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    expect(handle).toHaveAttribute('aria-valuemin', '160');
    expect(handle).toHaveAttribute('aria-valuemax', '640');
  });

  it('reports the new width as the pointer drags it', () => {
    const { onChange, handle } = setup();

    fireEvent(handle, pointer('pointerdown'));
    fireEvent(handle, pointer('pointermove', { clientX: 420 }));

    expect(onChange).toHaveBeenCalledWith(420);
  });

  it('ignores pointer movement that is not part of a drag', () => {
    const { onChange, handle } = setup();

    fireEvent(handle, pointer('pointermove', { clientX: 420 }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops reporting once the pointer is released', () => {
    const { onChange, handle } = setup();

    fireEvent(handle, pointer('pointerdown'));
    fireEvent(handle, pointer('pointerup'));
    fireEvent(handle, pointer('pointermove', { clientX: 420 }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not start a drag on a non-primary button', () => {
    const { onChange, handle } = setup();

    fireEvent(handle, pointer('pointerdown', { button: 2 }));
    fireEvent(handle, pointer('pointermove', { clientX: 420 }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps a drag to the bounds it was given', () => {
    const { onChange, handle } = setup();

    fireEvent(handle, pointer('pointerdown'));
    fireEvent(handle, pointer('pointermove', { clientX: 5 }));
    fireEvent(handle, pointer('pointermove', { clientX: 5000 }));

    expect(onChange).toHaveBeenNthCalledWith(1, 160);
    expect(onChange).toHaveBeenNthCalledWith(2, 640);
  });

  it('nudges with the arrow keys, so it works without a mouse', async () => {
    const { onChange, handle } = setup(300);

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{ArrowLeft}');

    expect(onChange).toHaveBeenNthCalledWith(1, 316);
    expect(onChange).toHaveBeenNthCalledWith(2, 284);
  });

  it('takes focus on pointerdown, so the arrow keys are reachable by mouse', () => {
    const { handle } = setup();

    fireEvent(handle, pointer('pointerdown'));

    expect(handle).toHaveFocus();
  });

  it('restores the default width on a double click', async () => {
    const { onReset, handle } = setup(600);

    await userEvent.dblClick(handle);

    expect(onReset).toHaveBeenCalled();
  });

  it('leaves the drag class off the body once a drag is over', () => {
    const { handle } = setup();

    fireEvent(handle, pointer('pointerdown'));
    expect(document.body).toHaveClass('is-resizing');

    fireEvent(handle, pointer('pointerup'));
    expect(document.body).not.toHaveClass('is-resizing');
  });
});
