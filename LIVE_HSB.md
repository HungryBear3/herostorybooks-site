# HeroStoryBooks canonical live state

Last updated: 2026-04-22

## Canonical live deployment
- Vercel deployment URL: `https://herostorybooks-site-gfjrjll0q-alexy-kapluns-projects.vercel.app`
- Custom domains:
  - `https://herostorybooks.com`
  - `https://www.herostorybooks.com`

## Canonical repo state
- Branch: `main`
- Commit: `4ed8fce`
- Commit message: `Revert "fix(hsb): restore exact v0 homepage design"`

## What this live version should look like
Homepage indicators:
- Headline: `Every Child Is the Hero of Their Story`
- Top nav includes:
  - `How It Works`
  - `See Samples`
  - `FAQ`
  - `Order Now`
- Hero CTAs:
  - `Create Your Book`
  - `See a Sample`
- Featured cards use `Create This Book`
- Supporting routes expected live:
  - `/samples`
  - `/how-it-works`
  - `/checkout`

## Root cause of the drift incident
The site did not change randomly.

What happened:
1. The premium live family existed and was good.
2. Later recovery work introduced commit `db6a0db` (`fix(hsb): restore exact v0 homepage design`).
3. That commit changed only the homepage presentation layer and replaced the approved premium hero/nav/book-showcase with the placeholder/v0-style version.
4. Production alias changes then moved the custom domain between multiple deployments during debugging/recovery.

Net result:
- Wrong homepage variant on `main`
- Wrong deployment family on the domain at different points

## Rollback / recovery rules
Do not repoint domains blindly.

Before changing production:
1. Verify target deployment visually against this document.
2. Confirm homepage headline and nav match the canonical indicators above.
3. Confirm `/samples` and `/checkout` load.
4. Only then change aliases.

## Safe recovery commands
Check current aliases:
```bash
vercel alias ls | grep -E 'herostorybooks\.com|www\.herostorybooks\.com|herostorybooks-site\.vercel\.app'
```

Repoint custom domains to canonical deployment:
```bash
vercel alias set herostorybooks-site-gfjrjll0q-alexy-kapluns-projects.vercel.app herostorybooks.com
vercel alias set herostorybooks-site-gfjrjll0q-alexy-kapluns-projects.vercel.app www.herostorybooks.com
```

## Operational rule
If someone says “restore HSB live,” restore to this deployment family / repo state unless a newer approved canonical state has been explicitly documented here first.
