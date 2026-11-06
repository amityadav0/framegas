"use client";
import { useEffect, useState } from "react";
import { age } from "./ui";

export interface Status {
  reachable: boolean;
  block?: number;
  blockTimestamp?: number;
  producing: boolean;
  live: boolean;
  reason: string | null;
  wallet: { address: string; token: string; eth: string } | null;
  tokens: { symbol: string; address: string }[];
}

const STALE_AFTER = 120;

function StatusPill({ status, now }: { status: Status | null; now: number }) {
  if (!status) return <span className="num text-[11.5px] text-faint">Gateway …</span>;
  const stale = !status.reachable || status.blockTimestamp === undefined || now - status.blockTimestamp > STALE_AFTER;
  const text = status.reachable && status.block !== undefined ? `Block ${status.block.toLocaleString("en-US")} · ${age(Math.max(0, now - status.blockTimestamp!))} ago` : "Gateway unreachable";
  return (
    <span
      title={stale ? "No new block for over 2 minutes" : "Producing blocks"}
      className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-[4px] border text-[11.5px] num ${stale ? "border-bad/40 bg-bad-soft !text-bad" : "border-ok/40 bg-ok-soft !text-ok"}`}
    >
      <span className={`size-1.5 rounded-full ${stale ? "bg-bad" : "bg-ok"}`} />
      {text}
    </span>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex h-7 rounded-[4px] border border-line-strong overflow-hidden" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-2.5 text-[12px] font-medium border-l border-line-strong first:border-l-0 disabled:opacity-40 disabled:cursor-not-allowed ${value === o.value ? "bg-fg text-bg" : "bg-panel text-muted hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"), []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    setTheme(next);
  };
  return (
    <button type="button" onClick={flip} aria-label="Toggle theme" className="h-7 w-[54px] rounded-[4px] border border-line-strong bg-panel text-[12px] font-medium text-muted hover:text-fg">
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

export function Header({ status, mode, onMode }: { status: Status | null; mode: "replay" | "live"; onMode: (m: "replay" | "live") => void }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line pb-3">
      <div className="min-w-0">
        <div className="text-[13px]">
          <span className="font-semibold tracking-[-0.01em]">FrameGas</span>
          <span className="text-muted"> — The permissionless gas-payment layer for Ethereum</span>
        </div>
        <div className="text-[11px] text-muted mt-0.5">Built for Hegotá · EF alt-mempool devnet (chain 1337)</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={status} now={now} />
        <Segmented
          value={mode}
          onChange={onMode}
          options={[
            { value: "replay", label: "Replay" },
            { value: "live", label: "Live", disabled: !status?.live, title: status?.live ? "Send from the demo wallet" : `Live is off: ${status?.reason ?? "checking the gateway"}` },
          ]}
        />
        <ThemeToggle />
      </div>
    </header>
  );
}
