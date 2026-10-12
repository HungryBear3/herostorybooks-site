// Withdrawal endpoint under the access cookie's /group-book path, so the
// browser sends the cookie without widening it. Same handler: identity is
// derived server-side from the cookie, and no cookie or no record is a 404.
export { POST } from '@/app/api/group-book/withdrawal/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
