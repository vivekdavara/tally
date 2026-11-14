import { requireTenant } from "@/server/dal";
import { invoiceLabel } from "@/server/invoices/format";
import { renderInvoicePdf } from "@/server/invoices/pdf";
import { getInvoice } from "@/server/invoices/service";

// GET /o/<slug>/invoices/<id>/pdf: the invoice as a PDF, for members of its organization only (requireTenant
// answers anyone else with the same 404 as a missing organization). A draft renders too, marked as a draft.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { organization, run } = await requireTenant(slug, "view");
  const invoice = await run((tx) => getInvoice(tx, id));
  if (!invoice) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const bytes = renderInvoicePdf({ organizationName: organization.name, invoice });
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoiceLabel(invoice.number)}.pdf"`,
      // Invoices are private: no shared cache may keep one.
      "Cache-Control": "private, no-store",
    },
  });
}
