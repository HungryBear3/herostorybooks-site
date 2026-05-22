import type { Metadata } from 'next';

import AdminBoard from './admin-board';
import AdminLogin from './admin-login';
import { isAdminCookieValid } from '@/lib/family-review/admin-auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Internal review · HeroStoryBooks',
  robots: { index: false, follow: false },
};

/**
 * /family-review/admin
 *
 * Cookie-gated. The reviewer signs in once via the POST /login endpoint,
 * which sets the fr_admin_session HttpOnly cookie. From that point all
 * /family-review/admin* pages and /api/family-review/admin/* routes
 * authenticate by reading the cookie — no key in the URL, no key in
 * history, no key in referer headers, no key in screenshots.
 *
 * Wrong/missing auth shows the login form. We deliberately avoid a 403
 * here so unauthenticated probes can't distinguish "admin route exists"
 * from "you need to sign in" — both responses are the same login screen.
 */
export default async function AdminPage() {
  const authed = await isAdminCookieValid();
  if (!authed) {
    return <AdminLogin />;
  }
  return <AdminBoard />;
}
