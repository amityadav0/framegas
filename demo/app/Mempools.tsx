"use client";
import type { Run } from "../lib/run";
import { mempoolsAnswered, mined, type StripState } from "../lib/strip";
import { Panel, short, shown, Tag } from "./ui";

/** Sets the rule name inside an error string apart, so it reads at a glance. */
function ErrorText({ text }: { text: string }) {
  const m = /(StorageReadNonSender|[A-Z][A-Za-z]+(?:NonSender|Forbidden|Violation))/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {text.slice(0, m.index)}
      <span className="font-semibold underline decoration-1 underline-offset-2">{m[0]}</span>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

function Card({ title, verdict, children }: { title: string; verdict: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex items-center justify-between px-3 h-9">
        <span className="text-[12.5px] font-medium">{title}</span>
        {verdict}
      </div>
      {children}
    </div>
  );
}

export function Mempools({ run, strip }: { run: Run | null; strip: StripState }) {
  const sent = run !== null && mempoolsAnswered(strip);
  const done = run !== null && mined(strip);
  const waiting = <Tag>{strip.sending ? "sending" : "not sent"}</Tag>;
  const okFrames = run?.frames.filter((f) => f.success).length ?? 0;

  return (
    <Panel title="Mempools" aside={<span className="text-[11px] text-muted">same signed bytes to both</span>}>
      <div className="px-3 py-2 border-b border-line text-[11.5px] text-muted">
        {run?.signed ? (
          <span className="num !text-muted">
            {run.signed.prefix}… · {run.signed.bytes} bytes · type 0x06
          </span>
        ) : (
          <span className="num !text-muted">{run ? short(run.hash, 10, 6) : "—"}</span>
        )}
      </div>

      <Card title="Canonical mempool" verdict={sent && run?.canonical ? <Tag tone={run.canonical.admitted ? "ok" : "bad"}>{run.canonical.admitted ? "admitted" : "rejected"}</Tag> : waiting}>
        <table className="grid-table">
          <tbody>
            <tr>
              <th>Method</th>
              <td className="num text-[11.5px]">{run?.canonical?.method ?? "eth_sendRawTransaction"}</td>
            </tr>
          </tbody>
        </table>
        <div className="px-3 pb-3 pt-1">
          <div className={`num text-[11.5px] leading-snug rounded-[3px] border px-2 py-1.5 break-words ${sent && run?.canonical && !run.canonical.admitted ? "border-bad/30 bg-bad-soft !text-bad" : "border-line bg-sunk !text-faint"}`}>
            {sent && run?.canonical ? <ErrorText text={run.canonical.message} /> : run && !run.canonical && sent ? "not compared for this transaction" : "—"}
          </div>
          {sent && run?.canonical && !run.canonical.admitted && (
            <p className="text-[11px] text-muted mt-1.5">Validation reads the v4 PoolManager's storage, which is not the sender's. Canonical rules forbid that.</p>
          )}
        </div>
      </Card>

      <Card title="Alt-mempool · ERC-8421" verdict={sent && run ? <Tag tone={run.alt.admitted ? "ok" : "bad"}>{run.alt.admitted ? "admitted" : "rejected"}</Tag> : waiting}>
        <table className="grid-table">
          <tbody>
            <tr>
              <th>Method</th>
              <td className="num text-[11.5px]">{run?.alt.method ?? "eth_sendFrameTransaction"}</td>
            </tr>
            <tr>
              <th>Admission checks</th>
              <td className={`num ${sent && run?.alt.checksTotal ? "!text-ok" : ""}`}>
                {shown(sent, run?.alt.checksTotal ? `${run.alt.checksPassed} / ${run.alt.checksTotal} passed` : "report unavailable")}
              </td>
            </tr>
            <tr>
              <th>Mined in block</th>
              <td className="num">{shown(done, run?.block?.toLocaleString("en-US") ?? "—")}</td>
            </tr>
            <tr>
              <th>Frames succeeded</th>
              <td className={`num ${done && okFrames < (run?.frames.length ?? 0) ? "!text-bad" : ""}`}>{shown(done, `${okFrames} / ${run?.frames.length ?? 0}`)}</td>
            </tr>
            <tr>
              <th>Explorer</th>
              <td className="num text-[11.5px]">
                {run ? (
                  <a href={run.explorerUrl} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:decoration-fg">
                    {short(run.hash, 8, 6)} ↗
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          </tbody>
        </table>
        {sent && run?.alt.checksNote && <p className="px-3 pb-3 pt-1 text-[10.5px] leading-snug text-faint">{run.alt.checksNote}</p>}
      </Card>
    </Panel>
  );
}
