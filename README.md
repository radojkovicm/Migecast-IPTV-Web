# Migecast IPTV Web

A browser-based IPTV player with large, simple controls and a Serbian Latin interface.
The public demo includes **Kurir TV, DELUXE MUSIC and Tagesschau24** — no login,
subscription or backend required.

![Migecast IPTV Web demo: channel list, favorites and player](docs/images/demo-desktop.png)

*Actual desktop interface before selecting a channel. Channel availability varies by location and source.*

## What is included?

| Edition | Features | Hosting |
| --- | --- | --- |
| Public TV demo | Three public channels, search, saved favorites, fullscreen and picture fit | Cloudflare Pages, Vercel or any static HTTPS host |
| Self-hosted application | Owner-managed accounts and playlists, live TV, movies, series, resume and per-user favorites | Your own Node.js, PostgreSQL and FFmpeg server |

This repository is a standalone public snapshot. The demo contains only the
three channels listed above; movies, series and account management belong to the
self-hosted edition. No hosted demo URL is available yet.

## Try the public demo locally

Requires Node.js 22.12+ and pnpm 10.28.2.

```sh
pnpm install --frozen-lockfile
pnpm demo:build
python3 -m http.server 4173 --bind 127.0.0.1 --directory demo/dist
```

Open http://localhost:4173. No account, database, API key or environment file is
needed. The demo does not contact a private application or proxy video through
its hosting provider. Streams go directly from the listed source to the viewer.

### Cloudflare Pages (recommended for the demo)

Connect your repository, select **None** as the framework, use
`pnpm demo:build` as the build command and `demo/dist` as the output directory.
Use Node.js 22.12 or newer. Leave environment variables and bindings empty.
Alternatively upload the contents of `demo/dist` through Pages Direct Upload.
See [Cloudflare static HTML documentation](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/).

### Vercel

Import the repository. The included `vercel.json` selects only the static demo
build and output. No Functions, database or server-side video processing is used.
The full application is not deployed by this configuration.

## Self-host the complete application

The full application preserves private account and playlist management. The
public demo is separate and cannot access your accounts or media sources.
See [self-hosting](docs/MANUAL_DEPLOYMENT.md),
[media worker](docs/WORKER_DEPLOYMENT.md) and [validation](docs/READINESS.md).

## Public channels

`demo/channels.json` contains a small selection of links from the
[Free-TV/IPTV public lists](https://github.com/Free-TV/IPTV/tree/master/lists).
Only links are included; no channel logos, recordings or programme data are
redistributed. Listing a URL is not a grant of rights in its programming.
Links can stop working or be geographically restricted. HTTPS, browser-compatible
codecs and source CORS support are required for the static demo. It cannot repair
an unavailable source or bypass a source's access restrictions.

## Development

```sh
pnpm db:generate
pnpm type-check
pnpm test
pnpm lint
pnpm demo:build
pnpm demo:test
```

Full integration tests use a fresh disposable PostgreSQL cluster; see the
validation guide. Do not point test commands at a production database.

## License

MIT for this application's code. Dependencies retain their own licenses; see
[third-party notices](THIRD_PARTY.md). The MIT license does not cover TV content.
