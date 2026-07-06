const PRODUCTION_ORIGIN = 'https://herostorybooks.com';

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function getSiteOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const previewOrigin =
    env.VERCEL_ENV === 'preview' ? normalizeOrigin(env.VERCEL_URL) : null;
  return (
    previewOrigin ??
    normalizeOrigin(env.NEXT_PUBLIC_URL) ??
    normalizeOrigin(env.VERCEL_PROJECT_PRODUCTION_URL) ??
    PRODUCTION_ORIGIN
  );
}

export function shouldIndexSite(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === 'production';
}
