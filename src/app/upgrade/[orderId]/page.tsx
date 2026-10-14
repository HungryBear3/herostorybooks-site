import UpgradeClient from './upgrade-client';

// The chooser is a bearer surface. The token arrives in the URL fragment,
// which never reaches this server render; the client lifts it into memory,
// scrubs the address bar, and sends it only in JSON bodies. This page
// therefore reads nothing from the order on the server and leaks nothing on
// a guessed URL.
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Printed copy at our cost · Hero Story Books',
  robots: { index: false, follow: false },
};

export default async function UpgradePage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <UpgradeClient orderId={orderId} />;
}
