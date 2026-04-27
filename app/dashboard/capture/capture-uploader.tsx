"use client";

/**
 * Drag-drop or click-to-upload image capture UI with status polling.
 *
 * Flow:
 *   1. User drops or selects an image.
 *   2. We POST to /api/captures (multipart). Returns { captureId }.
 *   3. We GET /api/captures/:id every 1.5s until status is terminal
 *      (done | needs_review | error).
 *   4. Render the result inline — Claude's reply_text, plus a deep
 *      link to whichever artifact got created.
 *
 * No local image storage on the client; preview uses object URLs that
 * we revoke on unmount.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Status = "pending" | "classifying" | "done" | "needs_review" | "error";

type CaptureView = {
  id: string;
  status: Status;
  detected_intent: string | null;
  detection_confidence: number | null;
  reply_text: string | null;
  error_message: string | null;
  routed_task_id: string | null;
  routed_event_id: string | null;
  routed_expense_id: string | null;
};

type LocalState =
  | { kind: "idle" }
  | { kind: "uploading"; previewUrl: string }
  | { kind: "tracking"; previewUrl: string; capture: CaptureView }
  | { kind: "error"; previewUrl: string | null; message: string };

export function CaptureUploader() {
  const [state, setState] = useState<LocalState>({ kind: "idle" });
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup poll + object URLs.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  async function handleFile(file: File) {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    // Allow a wide set: images (vision), PDFs (Claude doc), DOCX/XLSX
    // (server extracts text), plain text + CSV. Server enforces the
    // canonical allowlist; this is just a fast UX guard.
    const t = (file.type || "").toLowerCase();
    const ok =
      t.startsWith("image/") ||
      t === "application/pdf" ||
      t ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      t === "application/msword" ||
      t ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      t === "application/vnd.ms-excel" ||
      t === "text/plain" ||
      t === "text/csv";
    if (!ok) {
      setState({
        kind: "error",
        previewUrl: null,
        message:
          "Unsupported file type. Try an image, PDF, DOCX/DOC, XLSX/XLS, TXT, or CSV.",
      });
      return;
    }

    // Only image previews use object URLs; for everything else we
    // render a name + type badge in the tracking UI.
    const previewUrl = t.startsWith("image/")
      ? URL.createObjectURL(file)
      : "";
    setState({ kind: "uploading", previewUrl });

    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/captures", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!json.ok) {
        setState({
          kind: "error",
          previewUrl,
          message: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }

      // Start polling.
      const captureId: string = json.captureId;
      const initial: CaptureView = {
        id: captureId,
        status: json.status as Status,
        detected_intent: null,
        detection_confidence: null,
        reply_text: null,
        error_message: null,
        routed_task_id: null,
        routed_event_id: null,
        routed_expense_id: null,
      };
      setState({ kind: "tracking", previewUrl, capture: initial });
      pollTimerRef.current = setInterval(() => pollOnce(captureId), 1500);
      // Also kick one immediate poll so terminal states render fast.
      pollOnce(captureId);
    } catch (err: any) {
      setState({
        kind: "error",
        previewUrl,
        message: err?.message ?? "network error",
      });
    }
  }

  async function pollOnce(captureId: string) {
    try {
      const res = await fetch(`/api/captures/${captureId}`);
      const json = await res.json();
      if (!json.ok) return;
      const c = json.capture as CaptureView;
      setState((prev) =>
        prev.kind === "tracking"
          ? { ...prev, capture: c }
          : prev
      );
      if (
        c.status === "done" ||
        c.status === "needs_review" ||
        c.status === "error"
      ) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch {
      // Transient — keep polling.
    }
  }

  function reset() {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
    if ("previewUrl" in state && state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
    }
    setState({ kind: "idle" });
  }

  // ------ Drag-drop handlers ----------------------------------------
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  // ------ Render ----------------------------------------------------

  if (state.kind === "tracking" || state.kind === "uploading") {
    return (
      <section className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <div className="grid gap-5 sm:grid-cols-[200px_1fr]">
          {state.previewUrl ? (
            <img
              src={state.previewUrl}
              alt="Captured"
              className="max-h-64 w-full rounded-md border border-neutral-800 object-contain bg-neutral-900"
            />
          ) : (
            <div className="flex max-h-64 flex-col items-center justify-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-6 py-12 text-center">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
                Document
              </span>
              <p className="text-xs text-neutral-400">
                No preview — the file goes straight to Claude.
              </p>
            </div>
          )}
          <div className="min-w-0">
            {state.kind === "uploading" && (
              <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                Uploading…
              </p>
            )}
            {state.kind === "tracking" && (
              <CaptureStatusView capture={state.capture} onReset={reset} />
            )}
          </div>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="mt-10 rounded-lg border border-red-900/60 bg-red-950/20 p-5">
        <p className="font-mono text-[10px] uppercase tracking-wider text-red-300">
          Upload failed
        </p>
        <p className="mt-2 text-sm text-red-100">{state.message}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md border border-red-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-red-200 hover:border-red-600"
        >
          Try again
        </button>
      </section>
    );
  }

  // Idle: drop zone.
  return (
    <section className="mt-10">
      <label
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex min-h-[260px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragActive
            ? "border-brand bg-brand/5 text-brand"
            : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <p className="font-display text-2xl">
          Drop a file here
        </p>
        <p className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
          or click to choose · images, PDF, DOCX, XLSX, TXT, CSV · up to 25MB
        </p>
      </label>
    </section>
  );
}

function CaptureStatusView({
  capture,
  onReset,
}: {
  capture: CaptureView;
  onReset: () => void;
}) {
  if (capture.status === "pending" || capture.status === "classifying") {
    return (
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          {capture.status === "pending" ? "Queued…" : "Classifying with Claude…"}
        </p>
        <p className="mt-2 text-sm text-neutral-400">
          Looking at your image and figuring out what to do with it.
          This usually takes 2–4 seconds.
        </p>
      </div>
    );
  }

  if (capture.status === "error") {
    return (
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-red-300">
          Couldn&apos;t classify
        </p>
        <p className="mt-2 text-sm text-red-200">
          {capture.error_message ?? "Unknown error."}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-4 rounded-md border border-neutral-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 hover:border-neutral-700"
        >
          Try another
        </button>
      </div>
    );
  }

  // done or needs_review
  const intentLabel = capture.detected_intent ?? "(unclassified)";
  const confidence =
    capture.detection_confidence !== null
      ? `${Math.round(capture.detection_confidence * 100)}%`
      : "—";

  let actionLink: { href: string; label: string } | null = null;
  if (capture.routed_task_id) {
    actionLink = { href: "/dashboard", label: "View on dashboard" };
  } else if (capture.routed_event_id) {
    actionLink = {
      href: `/dashboard/events/${capture.routed_event_id}`,
      label: "Open event",
    };
  } else if (capture.routed_expense_id) {
    actionLink = { href: "/dashboard/invoices", label: "View expense report" };
  }

  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">
        {capture.status === "needs_review" ? "Needs review" : "Done"}
      </p>
      <p className="mt-2 flex items-center gap-2 text-sm">
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-300">
          {intentLabel}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {confidence} confidence
        </span>
      </p>
      {capture.reply_text && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-200">
          {capture.reply_text}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        {actionLink && (
          <Link
            href={actionLink.href}
            className="rounded-md border border-brand px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-brand hover:bg-brand/10"
          >
            {actionLink.label}
          </Link>
        )}
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-neutral-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 hover:border-neutral-700"
        >
          Capture another
        </button>
      </div>
    </div>
  );
}
