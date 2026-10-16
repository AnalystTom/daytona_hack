// The Reversy beaver, the same head the landing page uses. Decorative: "Reversy" or the message sits beside it.
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <img
      className="mark"
      src="/beaver-head.png"
      width={size}
      height={size}
      alt=""
    />
  );
}
