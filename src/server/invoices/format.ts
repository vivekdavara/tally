// Display formats shared by the pages and the PDF.

/** "INV-0042" for a numbered invoice, "Draft" otherwise. */
export function invoiceLabel(number: number | null): string {
  return number === null ? "Draft" : `INV-${String(number).padStart(4, "0")}`;
}

/** A calendar date as stored (UTC midnight for a DATE column), e.g. "Nov 12, 2026". */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export const STATUS_LABELS = { DRAFT: "Draft", OPEN: "Open", PAID: "Paid", VOID: "Void" } as const;
