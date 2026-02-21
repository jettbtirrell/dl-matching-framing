import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import Footer from "@/components/Footer";
import NavBar from "@/components/NavBar";
import "./globals.css";

/**
 * Why Poppins?
 * Drumbeat's production site uses Poppins (visible in their CSS).
 * Using the same font makes this prototype feel like a native Drumbeat
 * internal tool rather than a generic Next.js starter.
 *
 * We load only the weights we actually use (400, 500, 600) to keep
 * the page weight down. next/font/google handles self-hosting automatically,
 * so there's no runtime fetch to Google Fonts — it gets bundled at build time.
 */
const poppins = Poppins({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap", // Show fallback font while Poppins loads — avoids invisible text
  variable: "--font-poppins",
});

export const metadata: Metadata = {
  title: "Creator Match — Drumbeat",
  description:
    "Find the right TikTok creators for your nonprofit campaign and get personalized post framings in seconds.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={poppins.variable}>
      {/*
       * We apply the CSS variable from next/font to the html element, then
       * globals.css picks it up via --font-sans: var(--font-poppins).
       * This keeps font configuration in one place (layout.tsx) and avoids
       * hardcoding the font name in multiple spots.
       */}
      <body className="flex min-h-screen flex-col antialiased">
        <NavBar />
        {/* pt-16 = 64px — pushes all page content below the fixed navbar */}
        <div className="flex-1 pt-16">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
