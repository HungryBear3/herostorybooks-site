'use client';

import { CSSProperties, ReactNode } from 'react';

export function Wordmark({ size = 16 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <span
        className="wordmark-dot"
        style={{ width: size * 1.1, height: size * 1.1 }}
        aria-hidden
      />
      <span>HeroStoryBooks</span>
    </span>
  );
}

type IconName =
  | 'lock'
  | 'arrow-right'
  | 'check'
  | 'upload'
  | 'image'
  | 'x'
  | 'shield'
  | 'mail'
  | 'heart'
  | 'sparkle'
  | 'eye'
  | 'chevron-right'
  | 'chevron-down'
  | 'trash'
  | 'user'
  | 'alert';

export function Icon({
  name,
  size = 16,
  color = 'currentColor',
  stroke = 1.5,
}: {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
  switch (name) {
    case 'lock':
      return (
        <svg {...common}>
          <rect x="4" y="11" width="16" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case 'arrow-right':
      return (
        <svg {...common}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M5 12l4 4 10-10" />
        </svg>
      );
    case 'upload':
      return (
        <svg {...common}>
          <path d="M12 16V4M6 10l6-6 6 6" />
          <path d="M4 20h16" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="11" r="1.5" />
          <path d="M3 17l5-5 5 5 3-3 5 5" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />
        </svg>
      );
    case 'mail':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 4v6M12 14v6M4 12h6M14 12h6" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...common}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...common}>
          <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
        </svg>
      );
    case 'user':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      );
    case 'alert':
      return (
        <svg {...common}>
          <path d="M12 9v5M12 17.5v.5" />
          <path d="M10.3 3.7L2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z" />
        </svg>
      );
    default:
      return null;
  }
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={'check' + (checked ? ' checked' : '')}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          position: 'absolute',
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: 'none',
        }}
      />
      <span className="check-box" aria-hidden />
      <span className="check-label">{children}</span>
    </label>
  );
}

export function Steps({ total = 7, current = 1 }: { total?: number; current?: number }) {
  return (
    <div className="steps" aria-label={`Step ${current} of ${total}`}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={'step ' + (i + 1 < current ? 'done' : i + 1 === current ? 'now' : '')}
        />
      ))}
    </div>
  );
}

export function Rating({
  value,
  max = 5,
  onSelect,
}: {
  value: number;
  max?: number;
  onSelect?: (n: number) => void;
}) {
  return (
    <div className="rate" role="radiogroup">
      {Array.from({ length: max }).map((_, i) => (
        <button
          type="button"
          key={i}
          role="radio"
          aria-checked={i < value}
          aria-label={`Rate ${i + 1} of ${max}`}
          className={'rate-btn' + (i < value ? ' on' : '')}
          onClick={() => onSelect?.(i + 1)}
          disabled={!onSelect}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}

const PALETTES: Record<string, [string, string]> = {
  warm: ['#e9dec4', '#e3d4b3'],
  cool: ['#dcd9c6', '#cdc8af'],
  dusk: ['#dad3e0', '#c8c0d6'],
  forest: ['#d7dfcc', '#c5cfb6'],
  ochre: ['#ecd9b0', '#dcc188'],
  rust: ['#eccfbf', '#d9ad95'],
};

export function PhotoPH({
  label = 'photo',
  aspect = '1 / 1',
  tone = 'warm',
  style,
}: {
  label?: string;
  aspect?: string;
  tone?: keyof typeof PALETTES;
  style?: CSSProperties;
}) {
  const [a, b] = PALETTES[tone] ?? PALETTES.warm;
  return (
    <div
      className="photo-ph"
      style={{
        aspectRatio: aspect,
        background: `repeating-linear-gradient(45deg, ${a} 0 8px, ${b} 8px 16px)`,
        ...style,
      }}
    >
      <span className="ph-label">{label}</span>
    </div>
  );
}

export function StoryArt({ kind }: { kind: 'dino' | 'bedtime' | 'space' }) {
  if (kind === 'dino') {
    return (
      <svg
        viewBox="0 0 200 150"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ background: '#dfe4cf', display: 'block' }}
        aria-hidden
      >
        <defs>
          <filter id="wc-dino"><feGaussianBlur stdDeviation="6" /></filter>
        </defs>
        <g filter="url(#wc-dino)" opacity="0.85">
          <ellipse cx="40" cy="130" rx="60" ry="20" fill="#a8b58e" />
          <ellipse cx="150" cy="135" rx="70" ry="22" fill="#9aaa83" />
          <ellipse cx="60" cy="90" rx="45" ry="40" fill="#7e9168" />
          <ellipse cx="130" cy="80" rx="55" ry="48" fill="#94a87a" />
          <ellipse cx="170" cy="40" rx="22" ry="14" fill="#cfd9bf" />
          <ellipse cx="30" cy="35" rx="20" ry="12" fill="#dfe7d2" />
        </g>
        <g opacity="0.7">
          <circle cx="100" cy="50" r="9" fill="#f0e8d4" />
        </g>
      </svg>
    );
  }
  if (kind === 'bedtime') {
    return (
      <svg
        viewBox="0 0 200 150"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ background: '#2e2944', display: 'block' }}
        aria-hidden
      >
        <defs><filter id="wc-bed"><feGaussianBlur stdDeviation="5" /></filter></defs>
        <g filter="url(#wc-bed)" opacity="0.85">
          <ellipse cx="100" cy="150" rx="160" ry="40" fill="#3d3457" />
          <ellipse cx="40" cy="120" rx="50" ry="22" fill="#4a4068" />
          <ellipse cx="170" cy="115" rx="60" ry="20" fill="#4a4068" />
        </g>
        <g opacity="0.85">
          <circle cx="150" cy="40" r="20" fill="#f0e8d4" />
          <circle cx="155" cy="38" r="18" fill="#2e2944" />
        </g>
        <g fill="#f0e8d4" opacity="0.8">
          <circle cx="30" cy="30" r="1.2" />
          <circle cx="60" cy="55" r="0.9" />
          <circle cx="85" cy="25" r="1.1" />
          <circle cx="115" cy="60" r="0.8" />
          <circle cx="180" cy="80" r="1" />
          <circle cx="40" cy="80" r="0.9" />
          <circle cx="190" cy="30" r="1.3" />
          <circle cx="75" cy="85" r="0.9" />
        </g>
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 200 150"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
      style={{ background: '#2a3548', display: 'block' }}
      aria-hidden
    >
      <defs><filter id="wc-space"><feGaussianBlur stdDeviation="5" /></filter></defs>
      <g filter="url(#wc-space)" opacity="0.9">
        <circle cx="60" cy="70" r="40" fill="#6b5b8c" />
        <circle cx="58" cy="65" r="34" fill="#7d6ea3" />
        <ellipse cx="150" cy="90" rx="55" ry="14" fill="#b88a3e" opacity="0.6" />
        <circle cx="150" cy="90" r="22" fill="#c87454" />
      </g>
      <g fill="#f0e8d4" opacity="0.85">
        <circle cx="20" cy="20" r="1.2" />
        <circle cx="180" cy="30" r="1" />
        <circle cx="100" cy="20" r="0.8" />
        <circle cx="40" cy="120" r="0.9" />
        <circle cx="190" cy="120" r="1" />
        <circle cx="120" cy="130" r="0.7" />
        <circle cx="170" cy="60" r="0.7" />
        <circle cx="30" cy="90" r="0.6" />
      </g>
    </svg>
  );
}

export function WatercolorCrest() {
  return (
    <svg
      viewBox="0 0 120 120"
      width="96"
      height="96"
      style={{ display: 'block', margin: '0 auto' }}
      aria-hidden
    >
      <defs>
        <filter id="crest-wc" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <g filter="url(#crest-wc)" opacity="0.7">
        <circle cx="42" cy="55" r="28" fill="#c87454" />
        <circle cx="78" cy="55" r="28" fill="#b88a3e" />
        <circle cx="60" cy="78" r="22" fill="#6b5b8c" />
      </g>
      <circle cx="60" cy="60" r="6" fill="#f5ede0" opacity="0.85" />
    </svg>
  );
}
