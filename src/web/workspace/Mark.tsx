// Small Reversy mark: a browser window cut in two. Stands in for the beaver avatar until a final asset exists.
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      <rect width="28" height="28" rx="7" fill="var(--persimmon)" />
      <path
        d="M7 8.5h7.5l-3 11H7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"
        fill="var(--aubergine)"
      />
      <path
        d="M16.5 8.5H21a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7.5l3-11Z"
        fill="var(--aubergine)"
      />
      <circle cx="8.6" cy="10.6" r="0.9" fill="var(--parchment)" />
    </svg>
  );
}
