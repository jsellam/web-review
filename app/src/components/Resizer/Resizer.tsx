import { useRef } from 'react';
import styles from './Resizer.module.css';

/** Set on <body> for the duration of a drag; the rule lives in `styles/reset.css`. */
const DRAGGING_CLASS = 'is-resizing';

/** Keystroke nudge, and the jump when Page Up/Down is used instead. */
const STEP = 16;
const PAGE = 64;

interface Props {
  width: number;
  min: number;
  max: number;
  onChange(width: number): void;
  /** Double-click restores this. */
  onReset(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The draggable boundary between the file tree and the diff column. Width is
 * owned by the caller; this only reports where the pointer put the edge.
 *
 * A `separator` with `tabIndex` is the ARIA window-splitter pattern, so the
 * arrow keys have to work too — a handle that only responds to a 5px-wide drag
 * is unusable with a keyboard.
 */
export function Resizer({ width, min, max, onChange, onReset }: Props) {
  const handle = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const stop = () => {
    if (!dragging.current) return;
    dragging.current = false;
    handle.current?.removeAttribute('data-dragging');
    document.body.classList.remove(DRAGGING_CLASS);
  };

  const nudge = (delta: number) => onChange(clamp(width + delta, min, max));

  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={styles.handle}
      onPointerDown={(event) => {
        // `button` is 0 for the primary button. Tested as `> 0` rather than
        // `!== 0` because jsdom implements no PointerEvent and leaves the field
        // undefined — the non-primary case is the one worth rejecting, and this
        // way a fired pointerdown still exercises the drag under test.
        if (event.button > 0) return;
        // Capture so the drag survives the pointer leaving the 5px hit area,
        // which it does immediately on any brisk movement. Optional-called
        // because jsdom implements no pointer capture at all, and a test that
        // fires a pointerdown should exercise the drag, not throw.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        // `preventDefault` is what stops the pointerdown from starting a text
        // selection or a native drag — but it also cancels the focus the click
        // would otherwise have moved here, which would leave the arrow keys
        // below unreachable by mouse users. Focus explicitly instead.
        event.preventDefault();
        event.currentTarget.focus();
        dragging.current = true;
        event.currentTarget.setAttribute('data-dragging', 'true');
        document.body.classList.add(DRAGGING_CLASS);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        // Measured against the grid's own left edge rather than the viewport's,
        // so the width stays right if the shell is ever inset.
        const left = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
        onChange(clamp(event.clientX - left, min, max));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const delta =
          event.key === 'ArrowLeft' ? -STEP
          : event.key === 'ArrowRight' ? STEP
          : event.key === 'PageUp' ? -PAGE
          : event.key === 'PageDown' ? PAGE
          : 0;

        if (delta !== 0) {
          event.preventDefault();
          nudge(delta);
        } else if (event.key === 'Home') {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
