import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ronny J Ops",
  description: "Operations system for Ronny J Listen UP LLC",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-brand-ink text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
