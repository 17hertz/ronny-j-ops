"use client";

/**
 * Client-side intake form. Five logical sections — rendered in a single
 * scrollable page rather than a wizard because most vendors knock this
 * out in one sitting and wizards just hide the total time.
 *
 *   1. Company / contact
 *   2. Service category
 *   3. Tax (W9)
 *   4. ACH banking — REQUIRED
 *   5. Secondary payment (optional)
 *
 * W9 PDF upload is handled in a follow-up step after the initial submit
 * returns a `portal_token`. That lets us persist partial data and email
 * the vendor a resume link even if their upload fails.
 */
import { useState } from "react";
import {
  SERVICE_CATEGORIES,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";

type VendorType =
  | ""
  | "individual"
  | "sole_prop"
  | "llc"
  | "s_corp"
  | "c_corp"
  | "partnership"
  | "other";

type SecondaryMethod = "" | "zelle" | "paypal" | "venmo" | "other";

type FormState = {
  // Company
  legal_name: string;
  dba: string;
  vendor_type: VendorType;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  // Address
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  // Service
  service_category: ServiceCategoryId | "";
  service_notes: string;
  // W9
  tax_id: string;
  // ACH (required)
  ach_account_holder_name: string;
  ach_bank_name: string;
  ach_routing_number: string;
  ach_account_number: string;
  ach_account_type: "" | "checking" | "savings";
  // Secondary (optional)
  secondary_payment_method: SecondaryMethod;
  secondary_payment_handle: string;
};

type Submission =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted"; vendorId: string; email: string }
  | { kind: "error"; message: string };

const initialState: FormState = {
  legal_name: "",
  dba: "",
  vendor_type: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  service_category: "",
  service_notes: "",
  tax_id: "",
  ach_account_holder_name: "",
  ach_bank_name: "",
  ach_routing_number: "",
  ach_account_number: "",
  ach_account_type: "",
  secondary_payment_method: "",
  secondary_payment_handle: "",
};

export function VendorIntakeForm({
  prefillEmail,
  inviteToken,
  emailLocked,
}: {
  prefillEmail?: string;
  inviteToken?: string;
  emailLocked?: boolean;
} = {}) {
  const [form, setForm] = useState<FormState>({
    ...initialState,
    contact_email: prefillEmail ?? "",
  });
  const [status, setStatus] = useState<Submission>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!form.legal_name.trim()) errs.legal_name = "Required.";
    if (!form.contact_email.trim()) errs.contact_email = "Required.";
    if (!form.vendor_type) errs.vendor_type = "Required.";
    if (!form.service_category) errs.service_category = "Pick one.";

    // Tax ID: either a 9-digit SSN (individual/sole_prop) or EIN (XX-XXXXXXX).
    const taxDigits = form.tax_id.replace(/\D/g, "");
    if (taxDigits.length !== 9) {
      errs.tax_id = "Tax ID must be 9 digits (EIN or SSN).";
    }

    // ACH: all four fields required.
    if (!form.ach_account_holder_name.trim())
      errs.ach_account_holder_name = "Required.";
    const routing = form.ach_routing_number.replace(/\D/g, "");
    if (routing.length !== 9) {
      errs.ach_routing_number = "Routing number must be 9 digits.";
    }
    const account = form.ach_account_number.replace(/\D/g, "");
    if (account.length < 4 || account.length > 17) {
      errs.ach_account_number = "Account number must be 4–17 digits.";
    }
    if (!form.ach_account_type)
      errs.ach_account_type = "Checking or savings?";

    // Secondary: if method picked, handle required.
    if (
      form.secondary_payment_method &&
      !form.secondary_payment_handle.trim()
    ) {
      errs.secondary_payment_handle =
        "Add the email / phone / @handle for this method.";
    }
    return errs;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      // Focus the first invalid field for screen readers.
      const firstKey = Object.keys(errs)[0];
      const el = document.querySelector<HTMLElement>(`[name="${firstKey}"]`);
      el?.focus();
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/vendors/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, inviteToken: inviteToken ?? null }),
      });
      const json = (await res.json()) as
        | { ok: true; vendorId: string }
        | { ok: false; error: string; fieldErrors?: Record<string, string> };
      if (!res.ok || !json.ok) {
        if ("fieldErrors" in json && json.fieldErrors) {
          setFieldErrors(json.fieldErrors);
        }
        setStatus({
          kind: "error",
          message:
            ("error" in json && json.error) ||
            `Submit failed (${res.status}).`,
        });
        return;
      }
      setStatus({
        kind: "submitted",
        vendorId: json.vendorId,
        email: form.contact_email,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  if (status.kind === "submitted") {
    return (
      <div className="space-y-4">
        <p className="font-display text-2xl">You&apos;re in.</p>
        <p className="text-sm text-neutral-400">
          We got your info. A confirmation is on its way to{" "}
          <span className="text-neutral-100">{status.email}</span>. Next
          step: upload your signed W9 — we&apos;ll email you a secure link
          to that within a few minutes.
        </p>
        <p className="text-xs text-neutral-500">
          Reference ID: {status.vendorId}
        </p>
      </div>
    );
  }

  const submitting = status.kind === "submitting";

  return (
    <form onSubmit={onSubmit} className="space-y-10" noValidate>
      {/* ---------- 1. Company / contact ---------- */}
      <Section
        index={1}
        title="Who are you?"
        subtitle="Legal business name goes on the W9 — this is whoever cashes the check."
      >
        <Field
          name="legal_name"
          label="Legal name"
          value={form.legal_name}
          onChange={(v) => set("legal_name", v)}
          error={fieldErrors.legal_name}
          required
        />
        <Field
          name="dba"
          label="Doing business as (optional)"
          value={form.dba}
          onChange={(v) => set("dba", v)}
        />
        <Select
          name="vendor_type"
          label="Entity type"
          value={form.vendor_type}
          onChange={(v) => set("vendor_type", v as VendorType)}
          error={fieldErrors.vendor_type}
          required
          options={[
            { value: "", label: "Select…" },
            { value: "individual", label: "Individual / sole proprietor" },
            { value: "sole_prop", label: "Sole proprietor (with DBA)" },
            { value: "llc", label: "LLC" },
            { value: "s_corp", label: "S-corp" },
            { value: "c_corp", label: "C-corp" },
            { value: "partnership", label: "Partnership" },
            { value: "other", label: "Other" },
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="contact_name"
            label="Contact name"
            value={form.contact_name}
            onChange={(v) => set("contact_name", v)}
          />
          <Field
            name="contact_email"
            label="Contact email"
            type="email"
            value={form.contact_email}
            onChange={(v) => set("contact_email", v)}
            error={fieldErrors.contact_email}
            required
            readOnly={emailLocked}
          />
        </div>
        <Field
          name="contact_phone"
          label="Phone (SMS for reminders)"
          type="tel"
          value={form.contact_phone}
          onChange={(v) => set("contact_phone", v)}
          placeholder="+1 555 555 1234"
        />
        <Field
          name="address_line1"
          label="Address line 1"
          value={form.address_line1}
          onChange={(v) => set("address_line1", v)}
        />
        <Field
          name="address_line2"
          label="Address line 2 (optional)"
          value={form.address_line2}
          onChange={(v) => set("address_line2", v)}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            name="city"
            label="City"
            value={form.city}
            onChange={(v) => set("city", v)}
          />
          <Field
            name="state"
            label="State"
            value={form.state}
            onChange={(v) => set("state", v)}
          />
          <Field
            name="postal_code"
            label="ZIP"
            value={form.postal_code}
            onChange={(v) => set("postal_code", v)}
          />
        </div>
      </Section>

      {/* ---------- 2. Service category ---------- */}
      <Section
        index={2}
        title="What are we paying you for?"
        subtitle="Pick the closest match — helps Jason + Ronny slot your invoices into the right bucket."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {SERVICE_CATEGORIES.map((c) => {
            const checked = form.service_category === c.id;
            return (
              <label
                key={c.id}
                className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                  checked
                    ? "border-brand bg-brand/10"
                    : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                }`}
              >
                <input
                  type="radio"
                  name="service_category"
                  value={c.id}
                  checked={checked}
                  onChange={() => set("service_category", c.id)}
                  className="sr-only"
                />
                <div className="font-medium text-neutral-100">{c.label}</div>
                <div className="mt-1 text-xs text-neutral-400">{c.hint}</div>
              </label>
            );
          })}
        </div>
        {fieldErrors.service_category && (
          <p className="text-sm text-red-400">{fieldErrors.service_category}</p>
        )}
        <Field
          name="service_notes"
          label="Anything specific we should know?"
          value={form.service_notes}
          onChange={(v) => set("service_notes", v)}
          placeholder="Rate card, availability windows, past shows you worked, etc."
          textarea
        />
      </Section>

      {/* ---------- 3. Tax ---------- */}
      <Section
        index={3}
        title="Tax info (W9)"
        subtitle="Required by the IRS for any vendor we pay more than $600/year. We encrypt this at rest."
      >
        <Field
          name="tax_id"
          label="EIN or SSN (9 digits)"
          value={form.tax_id}
          onChange={(v) => set("tax_id", v)}
          error={fieldErrors.tax_id}
          placeholder="12-3456789"
          autoComplete="off"
          required
        />
        <div className="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm">
          <p className="font-medium text-neutral-200">
            You&apos;ll also need to send us a signed W9.
          </p>
          <p className="mt-1 text-neutral-400">
            After you submit this form we&apos;ll email you a secure link
            to upload your signed W9 PDF. Don&apos;t have one yet? Grab
            the official form from the IRS, fill it in, sign, scan, and
            upload.
          </p>
          <a
            href="https://www.irs.gov/pub/irs-pdf/fw9.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block font-mono text-xs uppercase tracking-[0.2em] text-brand underline"
          >
            Download IRS Form W-9 →
          </a>
        </div>
      </Section>

      {/* ---------- 4. ACH (required) ---------- */}
      <Section
        index={4}
        title="Bank account (ACH) — required"
        subtitle="This is how we'll send payouts by default. Full routing + account numbers are encrypted — only the last 4 show up in the dashboard."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="ach_account_holder_name"
            label="Account holder name"
            value={form.ach_account_holder_name}
            onChange={(v) => set("ach_account_holder_name", v)}
            error={fieldErrors.ach_account_holder_name}
            required
          />
          <Field
            name="ach_bank_name"
            label="Bank name"
            value={form.ach_bank_name}
            onChange={(v) => set("ach_bank_name", v)}
            placeholder="Chase, Bank of America, …"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="ach_routing_number"
            label="Routing number (9 digits)"
            value={form.ach_routing_number}
            onChange={(v) => set("ach_routing_number", v)}
            error={fieldErrors.ach_routing_number}
            autoComplete="off"
            required
          />
          <Field
            name="ach_account_number"
            label="Account number"
            value={form.ach_account_number}
            onChange={(v) => set("ach_account_number", v)}
            error={fieldErrors.ach_account_number}
            autoComplete="off"
            required
          />
        </div>
        <Select
          name="ach_account_type"
          label="Account type"
          value={form.ach_account_type}
          onChange={(v) =>
            set(
              "ach_account_type",
              v as FormState["ach_account_type"]
            )
          }
          error={fieldErrors.ach_account_type}
          required
          options={[
            { value: "", label: "Select…" },
            { value: "checking", label: "Checking" },
            { value: "savings", label: "Savings" },
          ]}
        />
      </Section>

      {/* ---------- 5. Secondary (optional) ---------- */}
      <Section
        index={5}
        title="Backup payment method (optional)"
        subtitle="For fast one-off payouts. ACH is still the primary rail — this is just a convenience."
      >
        <Select
          name="secondary_payment_method"
          label="Method"
          value={form.secondary_payment_method}
          onChange={(v) =>
            set("secondary_payment_method", v as SecondaryMethod)
          }
          options={[
            { value: "", label: "None" },
            { value: "zelle", label: "Zelle" },
            { value: "paypal", label: "PayPal" },
            { value: "venmo", label: "Venmo" },
            { value: "other", label: "Other" },
          ]}
        />
        {form.secondary_payment_method && (
          <Field
            name="secondary_payment_handle"
            label={
              form.secondary_payment_method === "venmo"
                ? "Venmo handle (e.g. @ronnyj)"
                : form.secondary_payment_method === "zelle"
                ? "Zelle email or phone"
                : form.secondary_payment_method === "paypal"
                ? "PayPal email"
                : "Handle / email / phone"
            }
            value={form.secondary_payment_handle}
            onChange={(v) => set("secondary_payment_handle", v)}
            error={fieldErrors.secondary_payment_handle}
            required
          />
        )}
      </Section>

      <div className="border-t border-neutral-800 pt-6">
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-brand px-4 py-3 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit for review"}
        </button>

        {status.kind === "error" && (
          <p className="mt-3 text-sm text-red-400">{status.message}</p>
        )}
        <p className="mt-4 text-xs text-neutral-600">
          By submitting you confirm the information is accurate and you
          authorize 17 Hertz Inc. to store it for payout purposes.
        </p>
      </div>
    </form>
  );
}

// ---------- form primitives ----------

function Section({
  index,
  title,
  subtitle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Step {index}
        </p>
        <h2 className="mt-1 font-display text-2xl">{title}</h2>
        <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  value,
  onChange,
  type = "text",
  required,
  placeholder,
  error,
  autoComplete,
  textarea,
  readOnly,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  error?: string;
  autoComplete?: string;
  textarea?: boolean;
  readOnly?: boolean;
}) {
  const base =
    "mt-2 w-full rounded-lg border bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:outline-none";
  const borderClass = error
    ? "border-red-500/60 focus:border-red-400"
    : "border-neutral-800 focus:border-brand";
  const readOnlyClass = readOnly ? "cursor-not-allowed opacity-70" : "";
  return (
    <label className="block">
      <span className="text-sm text-neutral-400">
        {label}
        {required && <span className="ml-1 text-brand">*</span>}
        {readOnly && (
          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
            from invite
          </span>
        )}
      </span>
      {textarea ? (
        <textarea
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
          readOnly={readOnly}
          className={`${base} ${borderClass} ${readOnlyClass}`}
        />
      ) : (
        <input
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          readOnly={readOnly}
          className={`${base} ${borderClass} ${readOnlyClass}`}
        />
      )}
      {error && <span className="mt-1 block text-xs text-red-400">{error}</span>}
    </label>
  );
}

function Select({
  name,
  label,
  value,
  onChange,
  options,
  required,
  error,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  required?: boolean;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm text-neutral-400">
        {label}
        {required && <span className="ml-1 text-brand">*</span>}
      </span>
      <select
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-2 w-full rounded-lg border bg-neutral-950 px-4 py-3 text-neutral-100 focus:outline-none ${
          error
            ? "border-red-500/60 focus:border-red-400"
            : "border-neutral-800 focus:border-brand"
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="mt-1 block text-xs text-red-400">{error}</span>}
    </label>
  );
}
