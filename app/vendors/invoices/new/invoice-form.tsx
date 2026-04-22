"use client";

/**
 * Invoice submission form — two modes in one component.
 *
 * Tabs:
 *   - "Generate invoice" (default) — we render a PDF from the form data
 *   - "Upload PDF"                  — vendor already has a PDF to attach
 *
 * Why one component vs. two routes?
 *   - Same metadata is collected in both modes (number, description, amount,
 *     due date). Having one page keeps that logic single-sourced.
 *   - Tab state is intentionally local (not URL-synced). A back-button that
 *     flips tabs after a half-filled form is worse UX than keeping it in
 *     component state.
 *
 * What this does NOT do:
 *   - Does NOT show a preview of the generated PDF. The server renders the
 *     PDF, stores it, and the vendor can open it from /vendors/account.
 *   - Does NOT handle progress for large PDF uploads. We cap at 15MB and
 *     rely on a single-shot fetch — anything fancier is overkill today.
 */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type LineItem = {
  description: string;
  quantity: number;
  unit_amount_cents: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "done"; invoiceId: string };

type Props = {
  vendorLegalName: string;
  achLast4: string | null;
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;

export function InvoiceForm({ vendorLegalName, achLast4 }: Props) {
  const [tab, setTab] = useState<"generate" | "upload">("generate");

  return (
    <div className="space-y-6">
      <div className="flex gap-2 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
        <TabButton
          active={tab === "generate"}
          onClick={() => setTab("generate")}
        >
          Generate invoice
        </TabButton>
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
          Upload PDF
        </TabButton>
      </div>

      {tab === "generate" ? (
        <GenerateInvoiceForm
          vendorLegalName={vendorLegalName}
          achLast4={achLast4}
        />
      ) : (
        <UploadInvoiceForm />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

// ---------- Shared field helpers ----------------------------------------

function parseDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept "1250", "1250.5", "1,250.50", "$1,250.50"
  const cleaned = trimmed.replace(/[$,]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents =
    parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0"), 10);
  if (!Number.isFinite(cents)) return null;
  return cents;
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// ---------- Upload mode -------------------------------------------------

function UploadInvoiceForm() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [description, setDescription] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [dueDate, setDueDate] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function resetForm() {
    setFile(null);
    setInvoiceNumber("");
    setDescription("");
    setAmountDollars("");
    setDueDate("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setFile(null);
      return;
    }
    if (f.type !== "application/pdf") {
      setStatus({ kind: "error", message: "Invoice must be a PDF." });
      setFile(null);
      return;
    }
    if (f.size > MAX_PDF_BYTES) {
      setStatus({
        kind: "error",
        message: "PDF exceeds 15MB. Try compressing it first.",
      });
      setFile(null);
      return;
    }
    setStatus({ kind: "idle" });
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) {
      setStatus({ kind: "error", message: "Attach a PDF." });
      return;
    }
    const cents = parseDollarsToCents(amountDollars);
    if (cents === null || cents < 1) {
      setStatus({ kind: "error", message: "Enter a valid amount." });
      return;
    }
    if (!invoiceNumber.trim()) {
      setStatus({ kind: "error", message: "Invoice number is required." });
      return;
    }
    if (!description.trim()) {
      setStatus({ kind: "error", message: "Description is required." });
      return;
    }

    setStatus({ kind: "submitting" });

    const body = new FormData();
    body.append("file", file);
    body.append("invoice_number", invoiceNumber.trim());
    body.append("invoice_description", description.trim());
    body.append("invoice_amount_cents", String(cents));
    body.append("invoice_due_at", dueDate || "");

    try {
      const res = await fetch("/api/vendors/invoices/submit", {
        method: "POST",
        body,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        invoiceId?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setStatus({
          kind: "error",
          message: json.error ?? `Upload failed (${res.status}).`,
        });
        return;
      }
      setStatus({ kind: "done", invoiceId: json.invoiceId ?? "" });
      resetForm();
      router.refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  const submitting = status.kind === "submitting";

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
      <SharedFields
        invoiceNumber={invoiceNumber}
        setInvoiceNumber={setInvoiceNumber}
        description={description}
        setDescription={setDescription}
        amountDollars={amountDollars}
        setAmountDollars={setAmountDollars}
        dueDate={dueDate}
        setDueDate={setDueDate}
        disabled={submitting}
      />

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            Invoice PDF
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={onPickFile}
            disabled={submitting}
            className="mt-2 block w-full cursor-pointer rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-400 file:mr-4 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-sm file:font-medium file:text-neutral-100 hover:file:bg-neutral-700"
          />
        </label>
        {file && (
          <p className="mt-2 text-xs text-neutral-500">
            Attached:{" "}
            <span className="text-neutral-200">{file.name}</span> (
            {prettyBytes(file.size)})
          </p>
        )}
      </div>

      <FormFooter status={status} submitLabel="Submit invoice" />
    </form>
  );
}

// ---------- Generate mode -----------------------------------------------

function GenerateInvoiceForm({
  vendorLegalName,
  achLast4,
}: {
  vendorLegalName: string;
  achLast4: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lineItems, setLineItems] = useState<
    Array<{
      description: string;
      quantity: string;
      unitDollars: string;
    }>
  >([{ description: "", quantity: "1", unitDollars: "" }]);

  // Manual override for total. When empty, total auto-computes.
  const [totalOverrideDollars, setTotalOverrideDollars] = useState("");

  const autoTotalCents = useMemo(() => {
    let total = 0;
    for (const li of lineItems) {
      const q = parseInt(li.quantity, 10);
      const unit = parseDollarsToCents(li.unitDollars);
      if (!Number.isFinite(q) || unit === null) continue;
      total += q * unit;
    }
    return total;
  }, [lineItems]);

  const overrideCents = parseDollarsToCents(totalOverrideDollars);
  const overriding =
    totalOverrideDollars.trim() !== "" && overrideCents !== null;
  const effectiveTotalCents = overriding ? overrideCents! : autoTotalCents;

  function updateLine(idx: number, patch: Partial<(typeof lineItems)[number]>) {
    setLineItems((prev) =>
      prev.map((li, i) => (i === idx ? { ...li, ...patch } : li))
    );
  }

  function addLine() {
    setLineItems((prev) => [
      ...prev,
      { description: "", quantity: "1", unitDollars: "" },
    ]);
  }

  function removeLine(idx: number) {
    setLineItems((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev
    );
  }

  function resetForm() {
    setInvoiceNumber("");
    setDescription("");
    setDueDate("");
    setLineItems([{ description: "", quantity: "1", unitDollars: "" }]);
    setTotalOverrideDollars("");
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!invoiceNumber.trim()) {
      setStatus({ kind: "error", message: "Invoice number is required." });
      return;
    }
    if (!description.trim()) {
      setStatus({ kind: "error", message: "Description is required." });
      return;
    }

    // Validate line items
    const cleanLines: LineItem[] = [];
    for (const li of lineItems) {
      const desc = li.description.trim();
      const q = parseInt(li.quantity, 10);
      const unit = parseDollarsToCents(li.unitDollars);
      if (!desc && unit === null && (!q || q === 1)) continue; // skip fully empty
      if (!desc) {
        setStatus({
          kind: "error",
          message: "Each line item needs a description.",
        });
        return;
      }
      if (!Number.isFinite(q) || q < 1) {
        setStatus({
          kind: "error",
          message: "Quantity must be at least 1.",
        });
        return;
      }
      if (unit === null || unit < 0) {
        setStatus({
          kind: "error",
          message: "Each line item needs a valid unit amount.",
        });
        return;
      }
      cleanLines.push({
        description: desc,
        quantity: q,
        unit_amount_cents: unit,
      });
    }

    if (cleanLines.length === 0) {
      setStatus({ kind: "error", message: "Add at least one line item." });
      return;
    }

    if (effectiveTotalCents < 1) {
      setStatus({
        kind: "error",
        message: "Invoice total must be greater than zero.",
      });
      return;
    }

    setStatus({ kind: "submitting" });

    try {
      const res = await fetch("/api/vendors/invoices/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "generate",
          invoice_number: invoiceNumber.trim(),
          invoice_description: description.trim(),
          invoice_amount_cents: effectiveTotalCents,
          invoice_due_at: dueDate || null,
          line_items: cleanLines,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        invoiceId?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setStatus({
          kind: "error",
          message: json.error ?? `Submit failed (${res.status}).`,
        });
        return;
      }
      setStatus({ kind: "done", invoiceId: json.invoiceId ?? "" });
      resetForm();
      router.refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  const submitting = status.kind === "submitting";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
          Your info (appears on PDF)
        </p>
        <p className="mt-2 text-sm text-neutral-200">{vendorLegalName}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {achLast4
            ? `Payment: ACH ···${achLast4}`
            : "No ACH on file — contact support before submitting."}
        </p>
      </div>

      <SharedFields
        invoiceNumber={invoiceNumber}
        setInvoiceNumber={setInvoiceNumber}
        description={description}
        setDescription={setDescription}
        amountDollars={totalOverrideDollars}
        setAmountDollars={setTotalOverrideDollars}
        dueDate={dueDate}
        setDueDate={setDueDate}
        disabled={submitting}
        amountLabel="Invoice total (override)"
        amountPlaceholder={
          autoTotalCents > 0
            ? `Auto: ${formatMoney(autoTotalCents)}`
            : "Leave blank to use line-item total"
        }
        amountNote={
          overriding
            ? `Overriding auto-total of ${formatMoney(autoTotalCents)}`
            : autoTotalCents > 0
              ? `Auto-total from line items: ${formatMoney(autoTotalCents)}`
              : "Fill in line items below and the total will compute automatically."
        }
      />

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            Line items
          </p>
          <button
            type="button"
            onClick={addLine}
            disabled={submitting}
            className="text-xs font-medium text-brand transition hover:opacity-80 disabled:opacity-40"
          >
            + Add line
          </button>
        </div>

        <ul className="mt-3 space-y-3">
          {lineItems.map((li, idx) => (
            <li
              key={idx}
              className="grid grid-cols-[1fr_64px_120px_auto] items-start gap-2"
            >
              <input
                type="text"
                value={li.description}
                onChange={(e) =>
                  updateLine(idx, { description: e.target.value })
                }
                placeholder="Description"
                disabled={submitting}
                maxLength={200}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
              />
              <input
                type="number"
                min={1}
                max={9999}
                step={1}
                value={li.quantity}
                onChange={(e) =>
                  updateLine(idx, { quantity: e.target.value })
                }
                placeholder="Qty"
                disabled={submitting}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={li.unitDollars}
                onChange={(e) =>
                  updateLine(idx, { unitDollars: e.target.value })
                }
                placeholder="$ Unit"
                disabled={submitting}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeLine(idx)}
                disabled={submitting || lineItems.length === 1}
                aria-label="Remove line item"
                className="mt-1 rounded-md px-2 py-1 text-neutral-500 transition hover:text-red-400 disabled:opacity-30"
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-center justify-between border-t border-neutral-800 pt-3 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            Total
          </span>
          <span
            className={`font-mono ${
              overriding ? "text-brand" : "text-neutral-100"
            }`}
          >
            {formatMoney(effectiveTotalCents)}
          </span>
        </div>
      </div>

      <FormFooter status={status} submitLabel="Generate and submit" />
    </form>
  );
}

// ---------- Shared UI ---------------------------------------------------

function SharedFields(props: {
  invoiceNumber: string;
  setInvoiceNumber: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  amountDollars: string;
  setAmountDollars: (v: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  disabled: boolean;
  amountLabel?: string;
  amountPlaceholder?: string;
  amountNote?: string;
}) {
  const {
    invoiceNumber,
    setInvoiceNumber,
    description,
    setDescription,
    amountDollars,
    setAmountDollars,
    dueDate,
    setDueDate,
    disabled,
    amountLabel = "Amount (USD)",
    amountPlaceholder = "1250.00",
    amountNote,
  } = props;

  return (
    <div className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
          Invoice number
        </span>
        <input
          type="text"
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
          disabled={disabled}
          maxLength={60}
          placeholder="INV-2026-042"
          className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
        />
      </label>

      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
          What is this invoice for?
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
          rows={3}
          maxLength={500}
          placeholder="e.g. Audio engineering for Ronny J session at Studio B, March 14-15"
          className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            {amountLabel}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            disabled={disabled}
            placeholder={amountPlaceholder}
            className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
          />
          {amountNote && (
            <p className="mt-1 text-[11px] text-neutral-500">{amountNote}</p>
          )}
        </label>

        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            Due date (optional)
          </span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={disabled}
            className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none"
          />
        </label>
      </div>
    </div>
  );
}

function FormFooter({
  status,
  submitLabel,
}: {
  status: Status;
  submitLabel: string;
}) {
  const submitting = status.kind === "submitting";
  return (
    <div className="space-y-3">
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-brand px-4 py-3 font-medium text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {submitting ? "Submitting…" : submitLabel}
      </button>
      {status.kind === "error" && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {status.message}
        </p>
      )}
      {status.kind === "done" && (
        <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-100">
          <p>
            Invoice submitted. We&apos;ll review it and update the status on
            your account page.
          </p>
          <p className="mt-2">
            <Link
              href="/vendors/account"
              className="underline hover:text-brand"
            >
              View your invoices
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
