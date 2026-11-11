import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally",
  description: "Invoicing for small businesses, one organization at a time.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
