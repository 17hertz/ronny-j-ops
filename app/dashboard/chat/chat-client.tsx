"use client";

/**
 * Client-side chat UI for the ops agent.
 *
 * State model:
 *   - `messages` is the public-facing turn log (what the user sees).
 *   - `history` is the raw Anthropic MessageParam[] we POST back to the API.
 *     It's a superset of `messages` — it includes tool_use / tool_result
 *     content that the user doesn't need to see rendered.
 *
 * The API route is stateless; the client owns the conversation. That keeps
 * v0.1 simple and means the user can trivially "start a new conversation"
 * by refreshing the page.
 */
import { useEffect, useRef, useState } from "react";

type VisibleMessage = {
  role: "user" | "assistant";
  text: string;
};

// Opaque history we pass to the server — don't narrow the type here, let it
// echo whatever the API returns.
type RawHistory = unknown[];

export function ChatClient({ userName }: { userName: string }) {
  const [messages, setMessages] = useState<VisibleMessage[]>([]);
  const [history, setHistory] = useState<RawHistory>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastToolCalls, setLastToolCalls] = useState<
    Array<{ name: string; input: unknown }>
  >([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || pending) return;

    setInput("");
    setError(null);

    const userMsg: VisibleMessage = { role: "user", text: trimmed };
    const nextVisible = [...messages, userMsg];
    setMessages(nextVisible);

    // Append a user turn in Anthropic's MessageParam shape.
    const nextHistory = [
      ...history,
      { role: "user", content: trimmed },
    ];

    setPending(true);
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: nextHistory }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error ?? "Agent error");
      }
      setMessages([
        ...nextVisible,
        { role: "assistant", text: payload.reply },
      ]);
      setHistory(payload.history);
      setLastToolCalls(payload.toolCalls ?? []);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setMessages([]);
    setHistory([]);
    setError(null);
    setLastToolCalls([]);
  }

  return (
    <>
      <div
        ref={scrollRef}
        className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-5"
      >
        {messages.length === 0 && (
          <p className="font-mono text-xs text-neutral-600">
            Hi {userName}. Try something like &quot;what invoices are waiting
            on me&quot; or &quot;any vendor applications from the last week
            I haven&apos;t reviewed&quot;.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "ml-auto max-w-[85%] rounded-lg bg-brand/10 px-4 py-3 text-sm text-neutral-100"
                : "mr-auto max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-100"
            }
          >
            <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
              {m.role === "user" ? userName : "agent"}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed">
              {m.text}
            </p>
          </div>
        ))}
        {pending && (
          <div className="mr-auto max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
              agent
            </p>
            <p className="mt-1 text-sm text-neutral-500">Thinking…</p>
          </div>
        )}
        {error && (
          <p className="rounded-md border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>

      {lastToolCalls.length > 0 && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          tools called:{" "}
          {lastToolCalls.map((t, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {t.name}
            </span>
          ))}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent..."
          disabled={pending}
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
          autoFocus
        />
        <button
          type="submit"
          disabled={pending || input.trim().length === 0}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "…" : "Send"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={pending || messages.length === 0}
          className="rounded-lg border border-neutral-800 px-4 py-3 text-sm text-neutral-500 transition hover:text-brand disabled:opacity-50"
        >
          New
        </button>
      </form>
    </>
  );
}
