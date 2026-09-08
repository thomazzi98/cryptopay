import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document shell.
 *
 * Fonts are loaded as variable web fonts with a real fallback stack, so a blocked font network gives
 * a readable page rather than an invisible one. `font-display: swap` is what Next's font loader sets
 * by default and is left alone: a payment page that shows nothing until a font arrives is worse than
 * one that reflows.
 */

export const metadata: Metadata = {
  title: { default: 'CryptoPay', template: '%s · CryptoPay' },
  description:
    'Accept USDC on Polygon. Every payment is verified against the chain by the backend, never by the browser.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1117' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-dvh bg-surface text-text antialiased">{children}</body>
    </html>
  );
}
