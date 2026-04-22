"use client";

/**
 * Client-side W9 uploader.
 *
 * Why a custom fetch rather than a plain <form action>?
 *   - We want inline progress / error states without a full page reload.
 *   - We want to client-side validate PDF + size before eating bandwidth.
 *
 * The actual upload hits /api/vendors/portal/[token]/upload — a
 * service-role handler that stores the file in Supabase Storage and
 * writes the vendor_documents row.
 */
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "error"; message: string }
  | { kind: "done" };

const MAX_BYTES = 15 * 1024 * 1024; // 15MB — generous for a scan
const ACCEPTED = ["application/pdf", "image/png", "image/jpeg"];

export function W9UploadForm({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setFile(null);
      return;
    }
    if (!ACCEPTED.includes(f.type)) {
      setStatus({
        kind: "error",
        message: "W9 must be a PDF, PNG, or JPG.",
      });
      setFile(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setStatus({
        kind: "error",
        message: "File is bigger than 15MB. Try a lower-res scan.",
      });
      setFile(null);
      return;
    }
    setStatus({ kind: "idle" });
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;
    setStatus({ kind: "uploading" });

    const body = new FormData();
    body.append("file", file);
    body.append("kind", "w9");

    try {
      const res = await fetch(`/api/vendors/portal/${token}/upload`, {
        method: "POST",
        body,
      });
      const json = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !json.ok) {
        setStatus({
          kind: "error",
          message:
            ("error" in json && json.error) ||
            `Upload failed (${res.status}).`,
        });
        return;
      }
      setStatus({ kind: "done" });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      // Refresh the server component so the "W9 on file" state shows.
      router.refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block">
        <span className="sr-only">Choose W9 file</span>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          onChange={onPick}
          className="block w-full cursor-pointer rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-400 file:mr-4 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-sm file:font-medium file:text-neutral-100 hover:file:bg-neutral-700"
        />
      </label>
      {file && (
        <p className="text-xs text-neutral-500">
          Ready to upload: <span className="text-neutral-200">{file.name}</span>{" "}
          ({prettyBytes(file.size)})
        </p>
      )}
      <button
        type="submit"
        disabled={!file || status.kind === "uploading"}
        className="w-full rounded-lg bg-brand px-4 py-3 font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {status.kind === "uploading" ? "Uploading…" : "Upload W9"}
      </button>
      {status.kind === "error" && (
        <p className="text-sm text-red-400">{status.message}</p>
      )}
      {status.kind === "done" && (
        <p className="text-sm text-emerald-400">
          Uploaded. Jason or Ronny will review your info and get back to you.
        </p>
      )}
    </form>
  );
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
