"use client";
import { PRESETS, type PresetId } from "../lib/presets";
import type { Run } from "../lib/run";
import type { Status } from "./Header";
import { Button, Panel, short, Tag } from "./ui";

export interface LiveForm {
  token: string;
  preset: PresetId;
  cap: string;
  quote: string | null;
  quoting: boolean;
}

interface Props {
  mode: "replay" | "live";
  replay: Run[];
  selected: number;
  onSelect: (i: number) => void;
  run: Run | null;
  minedShown: boolean;
  status: Status | null;
  form: LiveForm;
  onForm: (f: Partial<LiveForm>) => void;
  onSend: () => void;
  busy: boolean;
  error: { code: string; message: string } | null;
}

function Choice({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className={`flex items-start gap-2 px-3 py-1.5 border-t border-line first:border-t-0 ${disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer hover:bg-sunk"} ${checked ? "bg-sunk" : ""}`}>
      <input type="radio" className="mt-[3px] accent-[var(--fg)]" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export function Wallet(p: Props) {
  const replay = p.mode === "replay";
  const w = p.status?.wallet;
  const address = replay ? p.run?.sender : (w?.address ?? p.run?.sender);
  const symbol = p.run?.token.symbol ?? "fgUSD";
  const tokenBalance = replay
    ? p.minedShown && p.run?.balances.tokenAfter ? `${p.run.balances.tokenAfter}` : (p.run?.balances.tokenBefore ?? "—")
    : (w?.token ?? "—");
  const eth = replay ? (p.run?.balances.eth ?? "0") : (w?.eth ?? "0");
  const ethIsZero = /^0(\.0*)?$/.test(eth);
  const tokens = p.status?.tokens.length ? p.status.tokens : [{ symbol: "fgUSD", address: p.run?.token.address ?? "" }];

  return (
    <Panel title="Wallet" aside={<span className="text-[11px] text-muted">{replay ? "recorded" : "demo key"}</span>}>
      <table className="grid-table [&_tr:first-child>*]:border-t-0">
        <tbody>
          <tr>
            <th>Address</th>
            <td className="r num" title={address}>{address ? short(address, 8, 6) : "—"}</td>
          </tr>
          <tr>
            <th>{symbol}</th>
            <td className="r num">
              {tokenBalance}
              {replay && p.minedShown && p.run?.balances.tokenBefore && <div className="text-[10.5px] text-faint">was {p.run.balances.tokenBefore}</div>}
            </td>
          </tr>
          <tr>
            <th>ETH</th>
            <td className={`r num ${ethIsZero ? "!text-bad font-semibold" : ""}`}>{ethIsZero ? "0" : eth}</td>
          </tr>
          <tr>
            <th>Pay gas in</th>
            <td className="r">
              <select
                value={p.form.token}
                onChange={(e) => p.onForm({ token: e.target.value })}
                className="h-6 px-1 rounded-[3px] border border-line-strong bg-panel text-[12px] num"
              >
                {tokens.map((t) => (
                  <option key={t.symbol} value={t.symbol}>{t.symbol}</option>
                ))}
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="label px-3 pt-3 pb-1.5 border-t border-line">Action</div>
      <div className="border-t border-line text-[12.5px]">
        {replay &&
          p.replay.map((r, i) => (
            <Choice key={r.hash} checked={p.selected === i} onChange={() => p.onSelect(i)}>
              <span className="flex items-center gap-1.5">
                <span className="font-medium">Tx {i + 1}</span>
                <Tag>{r.mode}</Tag>
              </span>
              <span className="block text-muted">{r.call}</span>
            </Choice>
          ))}
        {PRESETS.map((x) => (
          <Choice key={x.id} checked={!replay && p.form.preset === x.id} disabled={replay} onChange={() => p.onForm({ preset: x.id })}>
            {x.label}
            {replay && <span className="ml-1.5 text-[10.5px] text-faint uppercase tracking-[0.06em]">live</span>}
          </Choice>
        ))}
      </div>

      <div className="px-3 py-3 border-t border-line space-y-2">
        <label className="block">
          <span className="flex justify-between text-[11.5px] text-muted mb-1">
            <span>maxTokenCost</span>
            <span className="num !text-muted">
              {replay ? "signed" : p.form.quoting ? "quoting…" : p.form.quote ? `quote ${p.form.quote}` : ""}
            </span>
          </span>
          <div className="flex h-8 rounded-[4px] border border-line-strong bg-panel focus-within:border-fg">
            <input
              inputMode="decimal"
              value={replay ? (p.run?.cost.cap ?? "") : p.form.cap}
              readOnly={replay}
              onChange={(e) => p.onForm({ cap: e.target.value })}
              className="num min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none read-only:text-muted"
            />
            <span className="px-2 self-center text-[11.5px] text-muted">{symbol}</span>
          </div>
        </label>
        <div className="w-full [&>button]:w-full [&>button]:h-8">
          <Button primary onClick={p.onSend} disabled={p.busy || (!replay && !p.form.cap)}>
            {replay ? "Replay transaction" : p.busy ? "Sending…" : "Sign and send"}
          </Button>
        </div>
        {p.error && (
          <p className="num text-[11.5px] !text-bad break-words">
            {p.error.code}: {p.error.message}
          </p>
        )}
      </div>
    </Panel>
  );
}
