import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import Footer from "@/components/Footer";
import NavBar from "@/components/NavBar";
import { PHProvider } from "@/components/PostHogProvider";
import "./globals.css";

/**
 * Poppins is loaded as the brand font — see app/globals.css for the rest
 * of the theme. Swap the font here and in globals.css to rebrand.
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
  title: "Creator Match",
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
        <PHProvider>
          <NavBar />
          {/* pt-16 = 64px — pushes all page content below the fixed navbar */}
          <div className="flex-1 pt-16">{children}</div>
          <Footer />
        </PHProvider>
      </body>
    </html>
  );
}
