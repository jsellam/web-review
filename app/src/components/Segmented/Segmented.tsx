import styles from './Segmented.module.css';

interface Props<T extends string> {
  /** Names the group for assistive tech. Visually hidden. */
  legend: string;
  /** Radio `name`. Must be unique across the page. */
  name: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(next: T): void;
}

/**
 * Native radios under the hood, so arrow-key navigation and the accessible
 * names the test suite queries come from the platform rather than from us.
 */
export function Segmented<T extends string>({ legend, name, options, value, onChange }: Props<T>) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className={styles.option}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className={styles.input}
          />
          <span className={styles.face}>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
