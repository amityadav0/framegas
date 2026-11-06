import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FrameGas demo",
  description: "Pay gas in any ERC-20 with EIP-8141 frame transactions, through the alt-mempool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
