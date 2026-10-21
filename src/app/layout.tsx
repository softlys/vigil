import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "VIGIL", template: "%s · VIGIL" },
  description: "Security monitoring for NEXORA: ingestion, integrity, detection, incidents and approved response.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0d0e11" };

/** VIGIL is dark only: the class is static, so no theme script runs before hydration. */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`} style={{ colorScheme: "dark" }}>
      <body className="min-h-full">
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position="top-center" closeButton />
        </TooltipProvider>
      </body>
    </html>
  );
}
