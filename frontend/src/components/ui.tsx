/**
 * ui.tsx — Shared presentational primitives: panels with explicit loading/empty/error
 * states, status badges and collapsible full-length output.
 */

import React, { useId, useState } from 'react';
import { stripAnsi } from '../lib/selectors';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'text-gray-300 border-gray-600 bg-gray-800/60',
  info: 'text-sky-300 border-sky-700 bg-sky-950/60',
  success: 'text-emerald-300 border-emerald-700 bg-emerald-950/60',
  warning: 'text-amber-300 border-amber-700 bg-amber-950/60',
  danger: 'text-red-300 border-red-700 bg-red-950/60',
  muted: 'text-gray-400 border-gray-700 bg-gray-900/60',
};

/** One mapping for every status word used by the backend, so semantics stay consistent. */
const STATUS_TONE: Record<string, Tone> = {
  created: 'neutral', pending: 'neutral',
  analyzing: 'info', planning: 'info', running: 'info', implementing: 'info', validating: 'info',
  awaiting_approval: 'warning', conditional: 'warning', rolled_back: 'warning',
  complete: 'success', completed: 'success', passed: 'success', ready: 'success', pass: 'success',
  failed: 'danger', timed_out: 'danger', blocked: 'danger', fail: 'danger',
  skipped: 'muted', missing: 'muted',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }): React.ReactElement {
  return (
    <span title={title} className={`inline-flex items-center text-[11px] font-mono uppercase tracking-wide px-2 py-0.5 rounded border ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function toneOf(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

interface PanelProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'danger' | 'warning';
  id?: string;
}

export function Panel({ title, subtitle, actions, children, tone = 'default', id }: PanelProps): React.ReactElement {
  const border = tone === 'danger' ? 'border-red-800' : tone === 'warning' ? 'border-amber-800' : 'border-surface-600';
  return (
    <section id={id} aria-label={typeof title === 'string' ? title : undefined} className={`bg-surface-800 border ${border} rounded-lg`}>
      <header className="px-4 py-3 border-b border-surface-600 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function StateMessage({ kind, children, onRetry }: {
  kind: 'loading' | 'empty' | 'error';
  children: React.ReactNode;
  onRetry?: () => void;
}): React.ReactElement {
  const color = kind === 'error' ? 'text-red-300' : 'text-gray-400';
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`text-sm ${color} py-3 flex items-center gap-3`}>
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-xs underline text-gray-300 hover:text-white">Retry</button>
      )}
    </div>
  );
}

/** Full text, collapsed to a few lines by default; nothing is ever permanently truncated. */
export function CollapsibleOutput({ label, text, collapsedLines = 8, tone = 'default' }: {
  label: string;
  text: string | null | undefined;
  collapsedLines?: number;
  tone?: 'default' | 'error';
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  const raw = text ?? '';
  const content = stripAnsi(raw);
  const strippedAnsi = content.length !== raw.length;
  if (!content.trim()) {
    return <p className="text-xs text-gray-500 font-mono">{label}: (empty)</p>;
  }
  const lines = content.split('\n');
  const long = lines.length > collapsedLines;
  const shown = open || !long ? content : lines.slice(0, collapsedLines).join('\n');
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 font-mono">
          {label} · {lines.length} line{lines.length === 1 ? '' : 's'}{strippedAnsi ? ' · terminal colour codes hidden' : ''}
        </span>
        {long && (
          <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
            className="text-xs text-sky-300 hover:text-sky-200">
            {open ? 'Collapse' : `Show all ${lines.length} lines`}
          </button>
        )}
      </div>
      <pre id={id} className={`mt-1 text-xs font-mono whitespace-pre-wrap break-words rounded border border-surface-600 bg-surface-900 p-2 max-h-[32rem] overflow-auto ${tone === 'error' ? 'text-red-200' : 'text-gray-200'}`}>
        {shown}{!open && long ? '\n…' : ''}
      </pre>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-200 break-words">{children}</dd>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = 'secondary', type = 'button', title }: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  type?: 'button' | 'submit';
  title?: string;
}): React.ReactElement {
  const cls = {
    primary: 'bg-sky-600 hover:bg-sky-500 text-white border-sky-500',
    secondary: 'bg-surface-700 hover:bg-surface-600 text-gray-200 border-surface-500',
    danger: 'bg-red-700 hover:bg-red-600 text-white border-red-600',
    success: 'bg-emerald-700 hover:bg-emerald-600 text-white border-emerald-600',
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${cls}`}>
      {children}
    </button>
  );
}
