type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
});

export function IconOutbound({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 11.5 11.5 4.5" />
      <path d="M6 4.5h5.5V10" />
    </svg>
  );
}

export function IconInbound({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M11.5 4.5 4.5 11.5" />
      <path d="M10 11.5H4.5V6" />
    </svg>
  );
}

export function IconSend({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 13V3" />
      <path d="M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function IconRefresh({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  );
}

export function IconChevron({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function IconStdio({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <path d="M5 7l1.75 1.75L5 10.5" />
      <path d="M8.75 10.5h2.5" />
    </svg>
  );
}

export function IconCloud({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.75 12.25a2.75 2.75 0 0 1-.3-5.48 3.5 3.5 0 0 1 6.72-.95 2.75 2.75 0 0 1 .58 5.43z" />
    </svg>
  );
}

export function IconSearch({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path d="m10.5 10.5 2.5 2.5" />
    </svg>
  );
}

export function IconPulse({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M1.5 8h3l1.75-4.5 2.5 9L10.5 8h4" />
    </svg>
  );
}
