/**
 * Direct expenses service — non-vendor, sales-tax-paid product purchases.
 *
 * Why direct_expenses exists alongside vendor_documents.invoice_*:
 *   - vendor invoices = SERVICES from a registered vendor (1099-eligible)
 *   - direct expenses = PRODUCTS from a retailer where sales tax was
 *     already collected (no W9 needed, no 1099 owed)
 *
 * Both roll into the consolidated expense reports.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type DirectExpenseRow = {
  id: string;
  team_member_id: string;
  merchant: string;
  amount_cents: number;
  sales_tax_cents: number | null;
  category: string | null;
  expense_date: string; // YYYY-MM-DD
  description: string | null;
  receipt_image_path: string | null;
  source_capture_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function createDirectExpense(opts: {
  teamMemberId: string;
  merchant: string;
  amountCents: number;
  salesTaxCents?: number | null;
  category?: string | null;
  expenseDate?: string | null; // YYYY-MM-DD; defaults to today
  description?: string | null;
  receiptImagePath?: string | null;
  sourceCaptureId?: string | null;
}): Promise<DirectExpenseRow> {
  const admin = createAdminClient();
  const { data, error } = (await (admin as any)
    .from("direct_expenses")
    .insert({
      team_member_id: opts.teamMemberId,
      merchant: opts.merchant.trim(),
      amount_cents: opts.amountCents,
      sales_tax_cents: opts.salesTaxCents ?? 0,
      category: opts.category?.trim() || "other",
      expense_date:
        opts.expenseDate ?? new Date().toISOString().slice(0, 10),
      description: opts.description?.trim() || null,
      receipt_image_path: opts.receiptImagePath ?? null,
      source_capture_id: opts.sourceCaptureId ?? null,
    })
    .select("*")
    .single()) as {
    data: DirectExpenseRow | null;
    error: { message: string } | null;
  };
  if (error || !data) {
    throw new Error(
      `createDirectExpense failed: ${error?.message ?? "no row"}`
    );
  }
  return data;
}
