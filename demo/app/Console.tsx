"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import type { Run } from "../lib/run";
import { initialStrip, mined, stripReducer } from "../lib/strip";
import { Header, type Status } from "./Header";
import { Mempools } from "./Mempools";
import { Transaction } from "./Transaction";
import { Wallet, type LiveForm } from "./Wallet";

const STEP_MS = 700;

export function Console({ replay }: { replay: Run[] }) {
  const [mode, setMode] = useState<"replay" | "live">("replay");
  const [selected, setSelected] = useState(0);
  const [liveRun, setLiveRun] = useState<Run | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [strip, dispatch] = useReducer(stripReducer, initialStrip);
  const [form, setForm] = useState<LiveForm>({ token: "fgUSD", preset: "swap", cap: "", quote: null, quoting: false });
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const run = mode === "replay" ? (replay[selected] ?? null) : liveRun;

  // Gateway status: chain height, block age, whether live mode can work.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const s = (await (await fetch("/api/status", { cache: "no-store" })).json()) as Status;
        if (!stop) setStatus(s);
      } catch {
        if (!stop) setStatus((s) => ({ ...(s ?? { tokens: [], wallet: null }), reachable: false, producing: false, live: false, reason: "status request failed" }));
      }
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // Live mode needs a producing chain: fall back to replay when it stops.
  useEffect(() => {
    if (mode === "live" && status && !status.live) setMode("replay");
  }, [mode, status]);

  // Loading a recorded transaction puts it at "signed", ready to step through.
  useEffect(() => {
    if (mode === "replay" && replay[selected]) dispatch({ type: "load", outcomes: replay[selected].frames.map((f) => f.success) });
    setError(null);
  }, [mode, selected, replay]);

  // Autoplay.
  useEffect(() => {
    if (!strip.playing) return;
    const t = setTimeout(() => dispatch({ type: "next" }), strip.position < 0 ? STEP_MS / 2 : STEP_MS);
    return () => clearTimeout(t);
  }, [strip.playing, strip.position]);

  // Keyboard: arrows step, space plays or pauses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight") dispatch({ type: "next" });
      else if (e.key === "ArrowLeft") dispatch({ type: "prev" });
      else if (e.key === " ") {
        e.preventDefault();
        dispatch({ type: strip.playing ? "pause" : "play" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [strip.playing]);

  // Live: quote the chosen preset and prefill maxTokenCost.
  useEffect(() => {
    if (mode !== "live") return;
    let stop = false;
    setForm((f) => ({ ...f, quoting: true, quote: null }));
    fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: form.token, preset: form.preset }) })
      .then(async (res) => {
        const body = await res.json();
        if (stop) return;
        if (res.ok) {
          setForm((f) => ({ ...f, quoting: false, quote: body.quote, cap: body.cap }));
          setError(null);
        } else {
          setForm((f) => ({ ...f, quoting: false }));
          setError(body.error);
        }
      })
      .catch((e) => !stop && (setForm((f) => ({ ...f, quoting: false })), setError({ code: "NETWORK", message: String(e) })));
    return () => {
      stop = true;
    };
  }, [mode, form.token, form.preset]);

  const send = useCallback(async () => {
    setError(null);
    if (mode === "replay") {
      dispatch({ type: "reset" });
      dispatch({ type: "play" });
      return;
    }
    setLiveRun(null);
    dispatch({ type: "sending" });
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: form.token, preset: form.preset, maxTokenCost: form.cap }),
      });
      const body = await res.json();
      if (!res.ok) {
        dispatch({ type: "failed" });
        setError(body.error);
        return;
      }
      setLiveRun(body as Run);
      dispatch({ type: "load", outcomes: (body as Run).frames.map((f) => f.success), play: true });
    } catch (e) {
      dispatch({ type: "failed" });
      setError({ code: "NETWORK", message: String(e) });
    }
  }, [mode, form.token, form.preset, form.cap]);

  return (
    <main className="mx-auto max-w-[1440px] px-4 sm:px-6 py-4">
      <Header status={status} mode={mode} onMode={(m) => (setMode(m), m === "live" && setLiveRun(null), m === "live" && dispatch({ type: "load", outcomes: [] }))} />
      <div className="grid gap-3 mt-3 lg:grid-cols-[minmax(240px,270px)_minmax(0,1fr)_minmax(290px,330px)] items-start">
        <Wallet
          mode={mode}
          replay={replay}
          selected={selected}
          onSelect={setSelected}
          run={run}
          minedShown={mined(strip)}
          status={status}
          form={form}
          onForm={(f) => setForm((s) => ({ ...s, ...f }))}
          onSend={send}
          busy={strip.sending}
          error={error}
        />
        <Transaction run={run} strip={strip} dispatch={dispatch} />
        <Mempools run={run} strip={strip} />
      </div>
      <footer className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-faint">
        <span>{mode === "replay" ? `Replay of transactions recorded ${run?.recordedAt ?? ""} on the devnet, from docs/evidence/` : "Live: sent from the demo key through @framegas/sdk with compareMempools"}</span>
        <span>← → step · space play</span>
      </footer>
    </main>
  );
}
