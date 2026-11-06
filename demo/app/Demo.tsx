"use client";

import { useEffect, useState } from "react";
import type { AdmissionReport } from "../lib/evidence";
import type { Run } from "../lib/run";

interface Status {
  live: boolean;
  producing: boolean;
  hasKey: boolean;
  block?: number;
  blockTimestamp?: number;
  tokens: { symbol: string; address: string }[];
}

type Step = "idle" | "signing" | "canonical" | "alt" | "mined";
const STEPS: Step[] = ["signing", "canonical", "alt", "mined"];
const STEP_LABELS: Record<Step, string> = { idle: "", signing: "Sign once", canonical: "Canonical mempool", alt: "Alt-mempool", mined: "Mined" };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export function Demo({ recorded, reports }: { recorded: Run[]; reports: AdmissionReport[] }) {
  const [mode, setMode] = useState<"replay" | "live">("replay");
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("fgUSD");
  const [run, setRun] = useState<Run | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [replayIndex, setReplayIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus({ live: false, producing: false, hasKey: false, tokens: [] }));
  }, []);

  const busy = step !== "idle" && step !== "mined";

  async function replay() {
    const next = recorded[replayIndex % recorded.length];
    if (!next) return;
    setError(null);
    setRun(null);
    for (const s of STEPS.slice(0, -1)) {
      setStep(s);
      await pause(700);
      if (s === "canonical") setRun({ ...next, alt: { ...next.alt, message: "…" }, frames: [] });
    }
    setRun(next);
    setStep("mined");
    setReplayIndex((i) => i + 1);
  }

  async function sendLive() {
    setError(null);
    setRun(null);
    setStep("signing");
    try {
      const res = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, amount: "1" }) });
      const body = await res.json();
      if (!res.ok) throw new Error(`${body.error?.code}: ${body.error?.message}`);
      setRun(body as Run);
      setStep("mined");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("idle");
    }
  }

  const liveReason = !status
    ? "checking the devnet…"
    : status.live
      ? `block ${status.block}`
      : !status.producing
        ? `the devnet is not producing blocks${status.block ? ` (last block ${status.block})` : ""}`
        : !status.hasKey
          ? "the server has no demo key"
          : "no tokens are deployed";

  const nextRecorded = recorded[replayIndex % recorded.length];
  const tokens = mode === "live" && status?.tokens.length ? status.tokens.map((t) => t.symbol) : ["fgUSD"];

  return (
    <main>
      <header>
        <p className="eyebrow">FrameGas · EIP-8141 · ERC-8421 alt-mempool · Uniswap v4</p>
        <h1>Pay gas in any token. Hold no ETH.</h1>
        <p className="lede">
          One signed frame transaction: a staked paymaster prices gas from a Uniswap v4 pool during validation, the user&apos;s
          tokens are swapped for exactly that ETH, the user&apos;s call runs, and unused gas comes back in tokens.
        </p>
      </header>

      <section className="controls" aria-label="Controls">
        <div className="segmented" role="tablist" aria-label="Data source">
          <button role="tab" aria-selected={mode === "replay"} onClick={() => setMode("replay")} disabled={busy}>
            Replay
          </button>
          <button role="tab" aria-selected={mode === "live"} onClick={() => setMode("live")} disabled={busy || !status?.live} title={status?.live ? undefined : liveReason}>
            Live
          </button>
        </div>
        <label className="field">
          <span>Pay gas in</span>
          <select value={token} onChange={(e) => setToken(e.target.value)} disabled={busy}>
            {tokens.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={mode === "live" ? sendLive : replay} disabled={busy || (mode === "live" && !status?.live)}>
          {busy ? "Sending…" : mode === "live" ? "Send 1 fgUSD" : `Play: ${nextRecorded?.mode === "bootstrap" ? "first transaction" : "second transaction"}`}
        </button>
        <p className="status">
          {mode === "replay" ? (
            <>Replaying transactions recorded on the devnet on 5 Nov 2026. Live: {liveReason}.</>
          ) : (
            <>Live on the devnet, {liveReason}.</>
          )}
        </p>
      </section>

      <ol className="steps" aria-label="Progress">
        {STEPS.map((s) => (
          <li key={s} data-state={STEPS.indexOf(s) < STEPS.indexOf(step as Step) || step === "mined" ? "done" : s === step ? "active" : "todo"}>
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="mempools" aria-label="Both mempools">
        <article className={`card ${run?.canonical ? (run.canonical.admitted ? "ok" : "bad") : ""}`}>
          <h2>Canonical mempool</h2>
          <p className="sub">EIP-8141&apos;s own rules. No staking, no reputation.</p>
          {run?.canonical ? (
            <>
              <p className="verdict">{run.canonical.admitted ? "Admitted" : "Rejected"}</p>
              <code className="message">{run.canonical.message.replace(/^Invalid params: /, "")}</code>
              <p className="explain">Validation reads the pool&apos;s storage, which is not the sender&apos;s.</p>
            </>
          ) : (
            <p className="placeholder">{step === "signing" ? "Submitting the signed bytes…" : "Waiting"}</p>
          )}
        </article>
        <article className={`card ${run && run.alt.message !== "…" ? (run.alt.admitted ? "ok" : "bad") : ""}`}>
          <h2>Alt-mempool</h2>
          <p className="sub">ERC-8421 rules, via the sidecar. The paymaster is staked.</p>
          {run && run.alt.message !== "…" ? (
            <>
              <p className="verdict">{run.alt.admitted ? "Admitted and mined" : "Rejected"}</p>
              <p>
                <a href={run.explorerUrl} target="_blank" rel="noreferrer">
                  {short(run.hash)}
                </a>
                {run.block !== null && <> in block {run.block}</>}
              </p>
              <p className="explain">The same signed bytes. Staking lets the paymaster read the pool.</p>
            </>
          ) : (
            <p className="placeholder">{step === "alt" || step === "canonical" ? "Submitting the same bytes…" : "Waiting"}</p>
          )}
        </article>
      </section>

      {run && run.frames.length > 0 && (
        <section className="detail" aria-label="Transaction">
          <h2>{run.label}</h2>
          <dl className="costs">
            <div><dt>User&apos;s ETH</dt><dd>0</dd></div>
            <div><dt>Paid in tokens</dt><dd>{Number(run.tokensPaid).toFixed(4)}</dd></div>
            <div><dt>Refunded</dt><dd>{Number(run.tokensRefunded).toFixed(4)}</dd></div>
            <div><dt>Net cost</dt><dd>{Number(run.netCost).toFixed(4)} fgUSD</dd></div>
            <div><dt>Gas fee</dt><dd>{Number(run.feeEth).toFixed(6)} ETH</dd></div>
          </dl>
          <table>
            <thead>
              <tr><th>Frame</th><th>Status</th><th className="num">Gas</th><th className="num">State gas</th></tr>
            </thead>
            <tbody>
              {run.frames.map((f, i) => (
                <tr key={i}>
                  <td>{i} · {f.name}</td>
                  <td className={f.success ? "pass" : "fail"}>{f.success ? "success" : "failed"}</td>
                  <td className="num">{Number(f.gasUsed).toLocaleString("en-US")}</td>
                  <td className="num">{Number(f.stateGasUsed).toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {run.screenshot && (
            <figure>
              <img src={`/evidence/${run.screenshot}`} alt={`Explorer page for ${run.hash}`} />
              <figcaption>The explorer page, captured when this transaction mined.</figcaption>
            </figure>
          )}
        </section>
      )}

      <section className="reports" aria-label="Admission reports">
        <h2>Admission reports</h2>
        <p className="sub">The sidecar&apos;s rule-by-rule verdicts, saved before the gateway restarted and its explorer forgot them.</p>
        {reports.map((r) => (
          <details key={r.hash}>
            <summary>
              {r.label === "bootstrap" ? "First transaction" : "Second transaction"} · {r.checks.filter((c) => c.passed).length} of {r.checks.length} checks passed ·{" "}
              <a href={r.explorerUrl} target="_blank" rel="noreferrer">{short(r.hash)}</a>
            </summary>
            <ul className="checks">
              {r.checks.map((c, i) => (
                <li key={i} className={c.passed ? "pass" : "fail"}>
                  <code>{c.rule}</code> <span>{c.scope}</span>
                </li>
              ))}
            </ul>
            {r.screenshots.map((s) => (
              <img key={s} src={`/evidence/${s}`} alt={`Explorer capture ${s}`} />
            ))}
          </details>
        ))}
      </section>

      <footer>
        <p>
          Devnet only: EIP-8141 is scheduled for Hegotá. The devnet stopped producing blocks on 6 Nov 2026, which is why
          replay exists. Code and findings: <a href="https://github.com/amityadav0/framegas">github.com/amityadav0/framegas</a>.
        </p>
      </footer>
    </main>
  );
}
