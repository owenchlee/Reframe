import React from 'react';
import { STATES } from './sessions.js';

const COLORS = { engaged: 'var(--engaged)', neutral: 'var(--neutral)', cold: 'var(--cold)' };
const R = 92;
const STROKE = 28;
// A round cap extends past each end by half the stroke; inset keeps a visible gap between pills.
const CAP_DEG = ((STROKE / 2) / R) * (180 / Math.PI);
const GAP_DEG = 7;
const INSET = CAP_DEG + GAP_DEG / 2;

function point(a) {
  const rad = ((a - 90) * Math.PI) / 180;
  return [120 + R * Math.cos(rad), 120 + R * Math.sin(rad)];
}

function arc(a0, a1) {
  const [x0, y0] = point(a0);
  const [x1, y1] = point(a1);
  return `M ${x0} ${y0} A ${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// Pill-segmented ring sized by each state's share of the conversation.
export default function Ring({ shares, children, label, className = '' }) {
  const sum = shares ? STATES.reduce((a, k) => a + shares[k], 0) : 0;
  let cursor = 0;
  const pills = [];
  if (sum > 0) {
    for (const key of STATES) {
      const span = (shares[key] / sum) * 360;
      if (span <= 0) continue;
      const a0 = cursor + INSET;
      const a1 = cursor + span - INSET;
      cursor += span;
      pills.push({ key, d: a1 > a0 ? arc(a0, a1) : arc(cursor - span / 2, cursor - span / 2 + 0.01) });
    }
  }
  return (
    <div className={`ring-wrap ${className}`} role="img" aria-label={label}>
      <svg viewBox="0 0 240 240" className="ring" aria-hidden="true">
        {pills.length === 0 && <circle cx="120" cy="120" r={R} className="ring-empty" />}
        {pills.map((p) => (
          <path key={p.key} d={p.d} stroke={COLORS[p.key]} className="pill-arc" />
        ))}
      </svg>
      {children && <div className="ring-center">{children}</div>}
    </div>
  );
}
