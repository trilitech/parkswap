import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "ParkSwap",
  description: "Minimal swap and pool UI for USDC/xU3O8 on Tezos X testnet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster position="bottom-right" richColors theme="light" />
      </body>
    </html>
  );
}
