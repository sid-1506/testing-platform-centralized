import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { IconName } from './icons';

export interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  title: string;
  badge?: number | null;
}

export interface NavSection<T extends string> {
  heading: string;
  items: Array<NavItem<T>>;
}

interface SidebarProps<T extends string> {
  sections: Array<NavSection<T>>;
  active: T;
  onSelect: (id: T) => void;
  targetName: string | null;
  isRunning: boolean;
}

/**
 * Primary navigation. One surface (the indicator) slides behind the active item instead of every
 * item repainting its own background, which is what makes moving between sections feel continuous.
 */
export function Sidebar<T extends string>({ sections, active, onSelect, targetName, isRunning }: SidebarProps<T>) {
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ y: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
      setIndicator(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active]);

  return (
    <aside className="sidebar" id="primary-navigation" aria-label="Main Navigation">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-text">
          <span className="brand-title">Testing Platform</span>
          <span className="brand-sub">Centralized QA</span>
        </span>
      </div>

      <nav className="nav" ref={navRef}>
        <span
          className="nav-indicator"
          aria-hidden="true"
          style={indicator ? { transform: `translateY(${indicator.y}px)`, height: indicator.h } : { opacity: 0 }}
        />
        {sections.map((section) => (
          <div key={section.heading} className="nav-section">
            <div className="nav-heading">{section.heading}</div>
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${active === item.id ? 'is-active' : ''}`}
                onClick={() => onSelect(item.id)}
                title={item.title}
                aria-current={active === item.id ? 'page' : undefined}
              >
                <span className="nav-icon">
                  <Icon name={item.icon} size={17} />
                </span>
                <span className="nav-label">{item.label}</span>
                {item.badge !== undefined && item.badge !== null && <span className="nav-badge">{item.badge}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="sidebar-target">
          <span className="sidebar-target-label">
            <span className={`live-dot ${isRunning ? 'is-live' : ''}`} />
            {isRunning ? 'Running' : 'Target'}
          </span>
          <span className="sidebar-target-value" title={targetName ?? undefined}>
            {targetName || 'None selected'}
          </span>
        </div>
      </div>
    </aside>
  );
}
