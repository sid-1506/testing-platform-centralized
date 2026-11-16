import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Bucket } from '../lib/metrics';
import { Icon } from './icons';

/* --------------------------------------------------------------------------
   Status pill
   -------------------------------------------------------------------------- */

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const live = status === 'running' || status === 'queued';
  const text = label ?? status;
  return (
    <span className={`pill status-${status}`}>
      <span className={`pill-dot ${live ? 'is-live' : ''}`} />
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Animated number — counts from the previous value to the new one.
   Honours prefers-reduced-motion (jumps straight to the value).
   -------------------------------------------------------------------------- */

const COUNT_MS = 900;

export function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => {
    const from = shownRef.current;
    const set = (n: number) => {
      shownRef.current = n;
      setShown(n);
    };
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === value) {
      set(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      const eased = 1 - Math.pow(1 - t, 4);
      set(t === 1 ? value : Math.round(from + (value - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span aria-label={`${value}${suffix}`}>
      <span aria-hidden="true">
        {shown.toLocaleString()}
        {suffix}
      </span>
    </span>
  );
}

/** Animates plain integers and "NN%" strings; anything else renders untouched. */
function animateValue(value: ReactNode): ReactNode {
  if (typeof value === 'number' && Number.isInteger(value)) return <AnimatedNumber value={value} />;
  if (typeof value === 'string') {
    const m = /^(\d+)%$/.exec(value);
    if (m) return <AnimatedNumber value={Number(m[1])} suffix="%" />;
  }
  return value;
}

/* --------------------------------------------------------------------------
   Delta chip (arrow + text) - direction only, colour handled in CSS
   -------------------------------------------------------------------------- */

export function DeltaChip({ value, suffix = '', hint }: { value: number | null; suffix?: string; hint?: string }) {
  if (value === null) return null;
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  if (dir === 'flat') {
    return (
      <span className="delta delta-flat" title={hint}>
        <Icon name="minus" size={12} strokeWidth={2.2} />
        Steady
      </span>
    );
  }
  return (
    <span className={`delta delta-${dir}`} title={hint}>
      <Icon name={dir === 'up' ? 'arrow-up-right' : 'arrow-down-right'} size={12} strokeWidth={2.2} />
      {dir === 'up' ? '+' : '−'}
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Sparkline (2px smooth line, soft wash, accent end dot with a surface ring)
   -------------------------------------------------------------------------- */

function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

interface SparklineProps {
  values: number[];
  label: string;
  emptyText?: string;
}

export function Sparkline({ values, label, emptyText = 'Trend appears after 2 runs' }: SparklineProps) {
  const gradId = useId();
  if (values.length < 2) {
    return <div className="spark spark-empty">{emptyText}</div>;
  }
  const W = 200;
  const H = 60;
  const padY = 10;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pts: Array<[number, number]> = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = span === 0 ? H / 2 : padY + (1 - (v - min) / span) * (H - padY * 2);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });
  const line = smoothPath(pts);
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;
  const last = pts[pts.length - 1];

  return (
    <div className="spark" role="img" aria-label={label}>
      <div className="spark-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.14" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="spark-dot" style={{ left: `${(last[0] / W) * 100}%`, top: `${(last[1] / H) * 100}%` }} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Split bar: one run divided into passed / not passing / skipped
   -------------------------------------------------------------------------- */

export function SplitBar({ passed, failed, skipped }: { passed: number; failed: number; skipped: number }) {
  const parts = [
    { key: 'pass', label: 'passed', n: passed },
    { key: 'fail', label: 'failed or errored', n: failed },
    { key: 'skip', label: 'skipped', n: skipped },
  ];
  const total = passed + failed + skipped;
  return (
    <div className="split" role="img" aria-label={`${passed} passed, ${failed} failed or errored, ${skipped} skipped`}>
      <div className="split-bar">
        {total > 0 && parts.filter((p) => p.n > 0).map((p) => <span key={p.key} className={`split-seg split-${p.key}`} style={{ flexGrow: p.n }} />)}
      </div>
      <div className="split-legend" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key}>
            <i className={`swatch swatch-${p.key}`} />
            <strong>{p.n}</strong> {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Stacked bar chart: passed (ink) under failed (status red), one y-axis
   -------------------------------------------------------------------------- */

/** Smallest "round", even axis maximum that contains v — so the half-way tick is a whole number. */
function niceMax(v: number): number {
  if (v <= 2) return 2;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 5, 6, 8, 10]) {
    const candidate = m * pow;
    if (candidate >= v && candidate % 2 === 0) return candidate;
  }
  return 10 * pow;
}

interface BarChartProps {
  buckets: Bucket[];
  unit: string;
  emptyText: string;
  showEveryLabel?: boolean;
}

export function BarChart({ buckets, unit, emptyText, showEveryLabel = true }: BarChartProps) {
  const peak = Math.max(0, ...buckets.map((b) => b.passed + b.failed));
  const max = niceMax(peak);
  const hasData = peak > 0;
  const totalPassed = buckets.reduce((a, b) => a + b.passed, 0);
  const totalFailed = buckets.reduce((a, b) => a + b.failed, 0);
  const ticks = [max, max / 2, 0];

  return (
    <div className="bars" role="group" aria-label={`${unit}: ${totalPassed} passed, ${totalFailed} failed`}>
      <div className="bars-y" style={{ '--digits': String(max).length } as CSSProperties} aria-hidden="true">
        {ticks.map((t, i) => (
          <span key={t} style={{ top: `${i * 50}%` }}>
            {t}
          </span>
        ))}
      </div>

      <div className="bars-plot">
        <i className="bars-grid" style={{ top: 0 }} />
        <i className="bars-grid" style={{ top: '50%' }} />
        {!hasData && <div className="bars-empty">{emptyText}</div>}
        {buckets.map((b, i) => {
          const total = b.passed + b.failed;
          const pct = (total / max) * 100;
          const edge = i < 2 ? 'is-start' : i >= buckets.length - 2 ? 'is-end' : '';
          return (
            <div
              className={`bar-col ${edge}`}
              key={b.key}
              tabIndex={0}
              style={{ '--h': `${pct}%`, '--i': i } as CSSProperties}
              aria-label={`${b.title}: ${b.passed} passed, ${b.failed} failed, ${b.runs} ${b.runs === 1 ? 'run' : 'runs'}`}
            >
              <div className="bar-tip" role="tooltip">
                <strong>{b.title}</strong>
                <span>
                  {b.runs} {b.runs === 1 ? 'run' : 'runs'} · {b.passed} passed · {b.failed} failed
                </span>
              </div>
              {total === 0 ? (
                <div className="bar-empty" />
              ) : (
                <div className="bar" style={{ height: `${pct}%` }}>
                  {b.failed > 0 && <div className="bar-seg bar-seg-fail" style={{ flexGrow: b.failed }} />}
                  {b.passed > 0 && <div className="bar-seg bar-seg-pass" style={{ flexGrow: b.passed }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bars-axis" aria-hidden="true">
        {buckets.map((b, i) => (
          <span key={b.key}>{showEveryLabel || i === 0 || i === buckets.length - 1 ? b.label : ''}</span>
        ))}
      </div>

      <div className="bars-legend">
        <span>
          <i className="swatch swatch-pass" /> Passed
        </span>
        <span>
          <i className="swatch swatch-fail" /> Failed
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Layout primitives
   -------------------------------------------------------------------------- */

export function CardHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="card-head">
      <div>
        <h3 className="card-title">{title}</h3>
        {subtitle && <p className="card-sub">{subtitle}</p>}
      </div>
      {actions && <div className="card-actions">{actions}</div>}
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  description,
  meta,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  sub,
  delta,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{animateValue(value)}</div>
      {(delta || sub) && (
        <div className="metric-foot">
          {delta}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}
