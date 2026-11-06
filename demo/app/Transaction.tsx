"use client";
import type { Dispatch } from "react";
import type { FrameRow, Run } from "../lib/run";
import { frameStatus, hasRun, mined, stageLabel, stepOf, type FrameStatus, type StripAction, type StripState } from "../lib/strip";
import { Button, int, Panel, short, shown, Tag } from "./ui";

const EDGE: Record<FrameStatus, string> = {
  pending: "border-t-line",
  current: "border-t-fg",
  ok: "border-t-ok",
  failed: "border-t-bad",
};

function FrameCell({ f, index, status }: { f: FrameRow; index: number; status: FrameStatus }) {
  const ran = status !== "pending";
  return (
    <li
      className={`min-w-0 border border-line border-t-2 ${EDGE[status]} rounded-[3px] px-2 py-1.5 transition-colors duration-300 ${status === "current" ? "bg-sunk border-x-line-strong border-b-line-strong" : "bg-panel"} ${ran ? "" : "text-faint"}`}
      aria-label={`frame ${index} ${f.name}: ${status}`}
    >
      <div className="flex justify-between text-[10.5px] text-muted">
        <span className="num !text-muted">{index}</span>
        <span>{f.role}</span>
      </div>
      <div className={`text-[13px] font-medium ${ran ? "text-fg" : ""}`}>{f.name}</div>
      <div className={`num text-[12px] mt-0.5 ${ran ? "" : "!text-faint"} ${status === "failed" ? "!text-bad" : ""}`}>{ran ? int(f.gasUsed) : "—"}</div>
      <div className="num text-[10.5px] !text-faint whitespace-nowrap">/ {int(f.gasLimit)}</div>
      {f.stateGasLimit !== "0" && (
        <div className={`num text-[10.5px] whitespace-nowrap mt-0.5 ${ran ? "!text-muted" : "!text-faint"}`} title="state gas used / limit">
          +{ran ? int(f.stateGasUsed) : "—"} state
          <div className="!text-faint">/ {int(f.stateGasLimit)}</div>
        </div>
      )}
    </li>
  );
}

/** The approve frame a normal-mode transaction leaves out, shown so the two modes line up. */
function SkippedApprove() {
  return (
    <li className="min-w-0 border border-dashed border-line rounded-[3px] px-2 py-1.5 text-faint" aria-label="approve frame not needed">
      <div className="text-[10.5px]">—</div>
      <div className="text-[13px] line-through decoration-1">approve</div>
      <div className="text-[10.5px] leading-tight mt-0.5">not needed: allowance covers the cap</div>
    </li>
  );
}

const pct = (a: string, b: string) => `${((Number(a) / Number(b)) * 100).toFixed(1)}% of cap`;

export function Transaction({ run, strip, dispatch }: { run: Run | null; strip: StripState; dispatch: Dispatch<StripAction> }) {
  if (!run) {
    return (
      <Panel title="Transaction">
        <p className="px-3 py-8 text-center text-muted">{strip.sending ? "Simulating, signing and submitting…" : "Choose an action and send it."}</p>
      </Panel>
    );
  }
  const idx = (k: FrameRow["kind"]) => run.frames.findIndex((f) => f.kind === k);
  const settled = hasRun(strip, idx("settle"));
  const refunded = hasRun(strip, idx("refund"));
  const done = mined(strip);
  const reserved = hasRun(strip, idx("validate"));
  const { step, of } = stepOf(strip);
  const cells = run.frames.map((f, i) => <FrameCell key={i} f={f} index={i} status={frameStatus(strip, i)} />);
  if (run.mode === "normal") cells.splice(2, 0, <SkippedApprove key="skip" />);
  const neg = (v: string) => (v.startsWith("-") ? `−${v.slice(1)}` : `+${v}`);

  return (
    <Panel
      title="Transaction"
      aside={
        <>
          <Tag>{run.mode === "bootstrap" ? "Bootstrap" : "Normal"}</Tag>
          <a href={run.explorerUrl} target="_blank" rel="noreferrer" className="num text-[11.5px] !text-muted hover:!text-fg underline decoration-line-strong underline-offset-2 truncate" title={run.hash}>
            {short(run.hash, 10, 6)}
          </a>
        </>
      }
    >
      <div className="px-3 pt-3">
        <ol className="grid grid-cols-3 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-fr gap-1.5">{cells}</ol>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2.5">
          <div className="flex gap-1">
            <Button onClick={() => dispatch({ type: "prev" })} title="Previous step (←)">‹</Button>
            <Button onClick={() => dispatch({ type: strip.playing ? "pause" : "play" })} title="Play or pause (space)">{strip.playing ? "Pause" : "Play"}</Button>
            <Button onClick={() => dispatch({ type: "next" })} title="Next step (→)">›</Button>
            <Button onClick={() => dispatch({ type: "end" })}>End</Button>
            <Button onClick={() => dispatch({ type: "reset" })}>Reset</Button>
          </div>
          <div className="text-[12px] text-muted">
            <span className="num !text-muted">{step}/{of}</span> · {stageLabel(strip, run.frames.map((f) => f.name))}
          </div>
        </div>
        <p className="text-[11.5px] text-muted mt-2">
          Call: <span className="text-fg">{run.call}</span>
          {run.mode === "bootstrap" && <> · first transaction: <span className="text-fg">approve</span> runs inside it, with no ETH</>}
        </p>
      </div>

      <div className="label px-3 pt-4 pb-1.5">Cost to the user, {run.token.symbol}</div>
      <table className="grid-table">
        <tbody>
          <tr>
            <th>Quote at validation</th>
            <td className="r num">{run.cost.quote ?? "—"}</td>
            <td className="text-[11.5px] text-muted">max cost at pool price + 5%</td>
          </tr>
          <tr>
            <th>Cap signed (maxTokenCost)</th>
            <td className="r num">{run.cost.cap}</td>
            <td className="text-[11.5px] text-muted">{run.cost.quote ? `quote is ${pct(run.cost.quote, run.cost.cap)}` : ""}</td>
          </tr>
          <tr>
            <th>Bought max cost at settle</th>
            <td className="r num">{shown(settled, run.cost.paid)}</td>
            <td className="text-[11.5px] text-muted">swap on the v4 pool</td>
          </tr>
          <tr>
            <th>Refunded</th>
            <td className="r num">{shown(refunded, neg(`-${run.cost.refunded}`))}</td>
            <td className="text-[11.5px] text-muted">unused gas, sold back</td>
          </tr>
          <tr className="font-medium">
            <th className="!text-fg">Paid</th>
            <td className="r num font-semibold">{shown(done, run.cost.net)}</td>
            <td className="text-[11.5px] text-muted">{done ? pct(run.cost.net, run.cost.cap) : ""}</td>
          </tr>
        </tbody>
      </table>

      <div className="label px-3 pt-4 pb-1.5">Paymaster, ETH</div>
      <table className="grid-table">
        <tbody>
          <tr>
            <th>Reserved by APPROVE</th>
            <td className="r num">{shown(reserved, neg(`-${run.paymaster.maxCost}`))}</td>
          </tr>
          <tr>
            <th>Bought at settle</th>
            <td className="r num">{shown(settled, neg(run.paymaster.bought))}</td>
          </tr>
          <tr>
            <th>Sold back at refund</th>
            <td className="r num">{shown(refunded, neg(`-${run.paymaster.sold}`))}</td>
          </tr>
          <tr>
            <th>Unused reserve returned</th>
            <td className="r num">{shown(done, neg(run.paymaster.returned))}</td>
          </tr>
          <tr>
            <th className="!text-fg font-medium">Net change</th>
            <td className={`r num font-semibold ${done ? (run.paymaster.delta.startsWith("-") ? "!text-bad" : "!text-ok") : ""}`}>{shown(done, neg(run.paymaster.delta))}</td>
          </tr>
        </tbody>
      </table>
      <div className="h-1" />
    </Panel>
  );
}
