import { Segmented } from '../Segmented/Segmented.js';
import { useTheme, type ThemeChoice } from '../../theme.js';

/** Typed as ThemeChoice[] so Segmented's generic infers T = ThemeChoice. */
const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();

  return (
    <Segmented
      legend="Theme"
      name="theme"
      options={OPTIONS}
      value={choice}
      onChange={setChoice}
    />
  );
}
