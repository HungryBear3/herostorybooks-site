import '../styles/globals.css';

export const metadata = {
  title: 'Hero Story Books',
  description: 'Create personalized hero story books!'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-cream text-gray-900">{children}</body>
    </html>
  );
}
