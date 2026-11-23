import WalletBar from "@/components/wallet-bar";
import NaijaPopupHost from "@/components/naija-popup";
import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "./globals.css";
import "./snooker/cinematic/style.css";

const fontFallbacks = {
  "--font-geist-sans": "Arial, Helvetica, sans-serif",
  "--font-geist-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
} as CSSProperties;

export const metadata: Metadata = {
  title: "SquadBet | Play with your squad",
  description: "Challenge friends in 8-ball Pool, Whot, and Ludo on SquadBet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" style={fontFallbacks}>
      <body className="min-h-full flex flex-col">
        <WalletBar />
        {children}
        <NaijaPopupHost />
      </body>
    </html>
  );
}

