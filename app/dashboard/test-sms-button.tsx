"use client";

/**
 * "Send test digest" dashboard buttons — SMS and WhatsApp variants.
 *
 * Both hit POST /api/notify/test-sms with a `channel` in the JSON body.
 * Server renders today's events + tasks into the digest body and sends
 * via the chosen channel to the logged-in team member's phone column.
 *
 * Surfaces three states:
 *   ok          → "Sent — body preview"
 *   skipped     → "SMS disabled (dev). Body would have been: ..."
 *                 (SMS-only — WhatsApp has no equivalent env gate)
 *   error       → the error message (missing phone, Twilio failure, etc.)
 *
 * In all three cases the rendered body is shown below so Jason can
 * iterate on wording without burning a real send.
 */
import { useState } from "react";

type Channel = "sms" | "whatsapp";

type SendState =
  | { kind: "idle" }
  | { kind: "sending"; channel: Channel }
  | { kind: "ok"; channel: Channel; to: string; body: string }
  | { kind: "skipped"; channel: Channel; body: string; error: string }
  | { kind: "error"; channel: Channel; error: string; body?: string };

export function TestSmsButton() {
  const [state, setState] = useState<SendState>({ kind: "idle" });

  async function send(channel: Channel) {
    setState({ kind: "sending", channel });
    try {
      const res = await fetch("/api/notify/test-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const json = await res.json();
      if (json.ok) {
        setState({ kind: "ok", channel, to: json.to, body: json.body });
        return;
      }
      if (json.skipped) {
        setState({
          kind: "skipped",
          channel,
          body: json.body ?? "",
          error: json.error ?? "disabled",
        });
        return;
      }
      setState({
        kind: "error",
        channel,
        error: json.error ?? `HTTP ${res.status}`,
        body: json.body,
      });
    } catch (e: any) {
      setState({
        kind: "error",
        channel,
        error: e?.message ?? "network error",
      });
    }
  }

  const busy = state.kind === "sending";
  const currentChannel = "channel" in state ? state.channel : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => send("sms")}
          disabled={busy}
          className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-brand hover:text-brand disabled:opacity-50"
        >
          {busy && currentChannel === "sms" ? "Sending..." : "Send test SMS"}
        </button>
        <button
          type="button"
          onClick={() => send("whatsapp")}
          disabled={busy}
          className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-brand hover:text-brand disabled:opacity-50"
        >
          {busy && currentChannel === "whatsapp"
            ? "Sending..."
            : "Send test WhatsApp"}
        </button>
        {state.kind === "ok" && (
          <span className="text-xs text-emerald-400">
            Sent via {state.channel} to {state.to}
          </span>
        )}
        {state.kind === "skipped" && (
          <span className="text-xs text-amber-400">
            {state.channel.toUpperCase()} disabled — preview below
          </span>
        )}
        {state.kind === "error" && (
          <span className="text-xs text-red-400">
            {state.channel}: {state.error}
          </span>
        )}
      </div>
      {"body" in state && state.body ? (
        <pre className="whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-300">
          {state.body}
        </pre>
      ) : null}
    </div>
  );
}
