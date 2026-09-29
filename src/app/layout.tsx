import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Quotebook — procurement that emails suppliers for you",
  description:
    "State what you need. Quotebook finds suppliers, emails them for real quotes, reads the replies, and shows a live comparison board.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  );
}
