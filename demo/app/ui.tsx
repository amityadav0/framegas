/** Small shared pieces of the console. */
import type { ReactNode } from "react";

export const short = (s: string, head = 6, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
export const int = (v: string | number | bigint) => BigInt(v).toLocaleString("en-US");

export function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 border border-line bg-panel rounded-[4px]">
      <header className="flex items-center justify-between gap-2 px-3 h-9 border-b border-line">
        <h2 className="label">{title}</h2>
        <div className="flex items-center gap-2 min-w-0">{aside}</div>
      </header>
      {children}
    </section>
  );
}

export function Tag({ tone = "plain", children }: { tone?: "ok" | "bad" | "plain"; children: ReactNode }) {
  const cls = tone === "ok" ? "text-ok bg-ok-soft border-ok/30" : tone === "bad" ? "text-bad bg-bad-soft border-bad/30" : "text-muted bg-sunk border-line";
  return <span className={`inline-flex items-center h-5 px-1.5 rounded-[3px] border text-[10.5px] font-medium tracking-[0.06em] uppercase ${cls}`}>{children}</span>;
}

export function Button({ children, onClick, disabled, primary, title }: { children: ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; title?: string }) {
  const cls = primary
    ? "bg-fg text-bg border-fg hover:opacity-90"
    : "bg-panel text-fg border-line-strong hover:bg-sunk";
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={`h-7 px-2.5 rounded-[4px] border text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed ${cls}`}>
      {children}
    </button>
  );
}

/** A value that appears only once the step that produces it has run. */
export const shown = (ready: boolean, value: ReactNode) => (ready ? value : <span className="text-faint">—</span>);
