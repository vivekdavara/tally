// Writes sample invoice PDFs (synthetic data) for looking at the layout: `npx tsx scripts/sample-pdf.ts <dir>`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInvoicePdf } from "../src/server/invoices/pdf";
import { sampleInvoice } from "../tests/fixtures/invoice";

const dir = process.argv[2] ?? ".scratch/pdf";
mkdirSync(dir, { recursive: true });
const many = Array.from({ length: 60 }, (_, i) => ({
  description: i % 7 === 0 ? `Line ${i + 1}: a long description that has to wrap onto a second line because it is wider than the column` : `Line ${i + 1}`,
  quantity: BigInt(1000 + i * 250),
  unitPriceMinor: BigInt(1999 + i * 101),
  taxRate: [0n, 5000n, 20000n][i % 3]!,
}));
const samples = {
  "open.pdf": sampleInvoice(),
  "draft.pdf": sampleInvoice({ status: "DRAFT" }),
  "long.pdf": sampleInvoice({ lines: many }),
  "eur-unicode.pdf": sampleInvoice({ currency: "EUR", lines: [{ description: "Café crème — Zoë's € test (東京)", quantity: 3000n, unitPriceMinor: 450n, taxRate: 7000n }] }),
};
for (const [name, invoice] of Object.entries(samples)) {
  writeFileSync(join(dir, name), renderInvoicePdf({ organizationName: "Cobol & Co.", invoice }));
  console.log(join(dir, name));
}
