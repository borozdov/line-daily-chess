# GitHub Pages deploy

GitHub Pages hosts only static files. This deploy publishes the React/PWA frontend, SEO pages, sitemap, robots.txt and static assets.

The FastAPI/PostgreSQL features are not hosted by GitHub Pages:

- server-side move validation
- unique nicknames
- leaderboard persistence
- share links backed by the API
- anti-abuse protection

## Setup

1. Push the repository to GitHub.
2. Open repository settings: `Settings -> Pages`.
3. Set `Source` to `GitHub Actions`.
4. Push to `main` or run the `Deploy GitHub Pages` workflow manually.

## Custom domain

This repo includes `public/CNAME` with:

```text
borozdov.ru
```

Point DNS to GitHub Pages:

```text
borozdov.ru      A      185.199.108.153
borozdov.ru      A      185.199.109.153
borozdov.ru      A      185.199.110.153
borozdov.ru      A      185.199.111.153
www.borozdov.ru  CNAME  borozdov.github.io
```

Then enable `Enforce HTTPS` in GitHub Pages settings.

## Without custom domain

If deploying to `https://borozdov.github.io/<repo>/`, remove `public/CNAME` and change the workflow build env:

```yaml
VITE_BASE_PATH: /<repo>/
```

The SEO canonical URLs currently point to `https://borozdov.ru/`.
