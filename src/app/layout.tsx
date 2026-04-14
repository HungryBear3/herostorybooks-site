import '../styles/globals.css';
// Removed unsupported Geist font import
import { cn } from "@/lib/utils";

// Removed unsupported Geist font setup

export const metadata = {
  title: 'Hero Story Books',
  description: 'Create personalized hero story books!'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="font-sans">
      <body className="bg-cream text-gray-900">{children}</body>
    </html>
  );
}
