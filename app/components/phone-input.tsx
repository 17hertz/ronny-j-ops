"use client";

/**
 * Country-code + phone input.
 *
 * Stores E.164 internally (e.g. "+14155551234") but shows the user a
 * country dropdown + plain digits. The digits field is display-only; you
 * type "4155551234" and the component concatenates with the selected
 * country prefix to produce the stored value.
 *
 * Usage:
 *   <PhoneInput value={phone} onChange={setPhone} />
 * where `value` is E.164 ("+14155551234") or empty string.
 *
 * The "Other" option reveals a free-text country-code entry so we don't
 * limit users to a hard-coded list. Numeric-only input enforcement on
 * the digits field keeps stored values clean.
 *
 * Why a component (and not a single `tel` input): E.164 is the universal
 * storage format required by Twilio and by our `sendSms` E.164 guard,
 * but the "+1" prefix is cognitive noise for US users who just think of
 * their number as 10 digits. This keeps the UI friendly without
 * corrupting storage.
 */
import { useMemo, useState } from "react";

export type PhoneInputProps = {
  value: string;
  onChange: (e164: string) => void;
  /** Form `id` + `name` for label association / form submission. */
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

// A small, curated list — we can expand when we hit a real user from
// somewhere not on it. "Other" always reveals the custom-code field.
const COUNTRIES: { code: string; flag: string; label: string }[] = [
  { code: "+1", flag: "🇺🇸", label: "US" },
  { code: "+1", flag: "🇨🇦", label: "Canada" },
  { code: "+44", flag: "🇬🇧", label: "UK" },
  { code: "+52", flag: "🇲🇽", label: "Mexico" },
  { code: "+61", flag: "🇦🇺", label: "Australia" },
  { code: "+33", flag: "🇫🇷", label: "France" },
  { code: "+49", flag: "🇩🇪", label: "Germany" },
  { code: "+81", flag: "🇯🇵", label: "Japan" },
];

// Parse an E.164 string into (countryCode, digits). Best-effort — we
// check against the known list first; if none matches, surface as
// "Other" with the full code preserved.
function parseE164(e164: string): { code: string; digits: string } {
  if (!e164 || !e164.startsWith("+")) return { code: "+1", digits: "" };
  // Try the known list, longest prefix first so "+1" doesn't shadow a
  // hypothetical "+12" entry.
  const sortedCodes = COUNTRIES.map((c) => c.code).sort(
    (a, b) => b.length - a.length
  );
  for (const code of sortedCodes) {
    if (e164.startsWith(code)) {
      return { code, digits: e164.slice(code.length) };
    }
  }
  // Unknown code — grab leading "+<digits>" and split there.
  const m = e164.match(/^(\+\d{1,4})(\d*)$/);
  if (m) return { code: m[1], digits: m[2] };
  return { code: "+1", digits: e164 };
}

export function PhoneInput({
  value,
  onChange,
  id,
  name,
  required,
  disabled,
  placeholder = "415 555 1234",
  className = "",
}: PhoneInputProps) {
  const initial = useMemo(() => parseE164(value), [value]);
  const [code, setCode] = useState<string>(initial.code);
  const [digits, setDigits] = useState<string>(initial.digits);
  const [customCode, setCustomCode] = useState<string>(
    COUNTRIES.some((c) => c.code === initial.code) ? "" : initial.code
  );
  const isOther =
    customCode !== "" || !COUNTRIES.some((c) => c.code === code);

  function updateOutput(nextCode: string, nextDigits: string) {
    const cleaned = nextDigits.replace(/\D/g, "");
    if (!cleaned) {
      onChange("");
    } else {
      onChange(`${nextCode}${cleaned}`);
    }
  }

  function handleCountrySelect(next: string) {
    if (next === "__other__") {
      setCustomCode(code);
      // Keep current code as initial custom value.
      return;
    }
    setCode(next);
    setCustomCode("");
    updateOutput(next, digits);
  }

  function handleCustomCode(raw: string) {
    // Allow "+" prefix + digits only. Cap to 5 chars ("+9999").
    let v = raw.replace(/[^+\d]/g, "");
    if (!v.startsWith("+")) v = "+" + v.replace(/\+/g, "");
    v = v.slice(0, 5);
    setCustomCode(v);
    setCode(v);
    updateOutput(v, digits);
  }

  function handleDigits(raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 15);
    setDigits(cleaned);
    updateOutput(code, cleaned);
  }

  return (
    <div className={`flex items-stretch gap-2 ${className}`}>
      <select
        aria-label="Country code"
        value={isOther ? "__other__" : code}
        onChange={(e) => handleCountrySelect(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
      >
        {COUNTRIES.map((c) => (
          <option key={`${c.label}-${c.code}`} value={c.code}>
            {c.flag} {c.label} ({c.code})
          </option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {isOther && (
        <input
          type="text"
          aria-label="Custom country code"
          value={customCode}
          onChange={(e) => handleCustomCode(e.target.value)}
          disabled={disabled}
          placeholder="+999"
          className="w-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      )}
      <input
        type="tel"
        inputMode="tel"
        id={id}
        name={name}
        value={digits}
        onChange={(e) => handleDigits(e.target.value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
      />
      {/* Hidden field storing the E.164 value for form submission when
          `name` is provided. Purely convenience for non-React form flows. */}
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
