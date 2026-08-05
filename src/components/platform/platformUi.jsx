// Small building blocks shared by more than one platform-console screen.

export const Switch = ({ checked, disabled, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={Boolean(checked)}
    aria-label={label}
    className="pc-switch"
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span />
  </button>
);
