import { useId } from "react";

/** The Remote's own mark, packages/remote/brand/icon.svg, drawn inline. */
export function BrandIcon({ size }: { size: number }) {
  const id = useId();
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden="true" style={{ flex: "none" }}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1B2740" />
          <stop offset="1" stopColor="#080D19" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx="0.5" cy="0.42" r="0.55">
          <stop offset="0" stopColor="#22C55E" stopOpacity="0.28" />
          <stop offset="1" stopColor="#22C55E" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#86EFAC" />
          <stop offset="1" stopColor="#16A34A" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${id}t)`} />
      <rect width="512" height="512" rx="112" fill={`url(#${id}g)`} />
      <g fill="none" stroke="#F1F5F9" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round">
        <rect x="92" y="118" width="328" height="226" rx="34" />
        <path d="M256 344v42M184 396h144" />
      </g>
      <path
        d="M226 180v102l90-51z"
        fill={`url(#${id}p)`}
        stroke={`url(#${id}p)`}
        strokeWidth="20"
        strokeLinejoin="round"
      />
    </svg>
  );
}
