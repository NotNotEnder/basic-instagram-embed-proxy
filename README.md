# Instagram Embed Proxy

Small Node service that mirrors Instagram path-style links and returns Discord-friendly embed metadata.

## What it does

Input:

`https://www.instagram.com/reel/DSGp2RSidjE/?igsh=NTc4MTIwNjQ2YQ==`

Output (your domain):

`https://myurl.com/reel/DSGp2RSidjE/?igsh=NTc4MTIwNjQ2YQ==`

Discord will unfurl `myurl.com/...` using the Open Graph/Twitter tags returned by this service.

The proxy now supports:

- video posts and reels
- image-only posts
- sidecar/carousel posts with multiple images
- mixed carousel posts that contain both images and videos

## Run

```bash
npm install
npm start
```

Server defaults to `http://localhost:3000`.

## Routes

- `GET /reel/:shortcode`
- `GET /p/:shortcode`
- `GET /tv/:shortcode`

Any query string is accepted (for example `?igsh=...`), but scraping uses a clean Instagram canonical URL to avoid share-link variants that can hide media metadata.

## Deploy

Deploy this service on any Node host (Railway, Fly.io, Render, VPS, etc.) and point your domain at it.

Environment variables:

- `PORT` (default `3000`)
- `CACHE_MS` in-memory cache TTL in milliseconds (default `300000`)
- `PUBLIC_BASE_URL` optional absolute base URL for generated media links (example: `https://myurl.com`)

## Notes / limitations

- Works only for publicly accessible Instagram posts/reels.
- Instagram can change page structure or block scraping behavior at any time.
- Instagram CDN media URLs are often short-lived and may expire.
- Discord and other unfurlers will usually preview the first media item; the full carousel is available on the rendered proxy page itself.
