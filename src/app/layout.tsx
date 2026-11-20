import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "EventFlow — Events, made easy",
    template: "%s · EventFlow",
  },
  description:
    "Create memorable events, sell tickets, and bring your community together with EventFlow.",
  applicationName: "EventFlow",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  openGraph: {
    title: "EventFlow — Events, made easy",
    description:
      "Create memorable events, sell tickets, and bring your community together.",
    siteName: "EventFlow",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        <Script id="eventflow-theme" strategy="beforeInteractive">
          {
            'var t=window.localStorage.getItem("eventflow-theme");if(t==="dark")document.documentElement.dataset.theme="dark";'
          }
        </Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
