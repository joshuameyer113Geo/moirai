# Moirai

One question to ChatGPT, Claude, and Grok, then the thread they share.

- Clotho spins: ChatGPT
- Lachesis measures: Claude
- Atropos cuts: Grok

Now an installable iPhone web app (PWA): dark neon-red matrix theme, swipeable Fate panels on phone (3-column grid on wide screens), sticky bottom action bar, bottom-sheet settings, offline app shell.

## Features

- Question box with prompt chips; **Listen** (speech recognition) to dictate
- **Ask all three** or Ask one per panel; each panel has **Ask / Best / Speak** and a live word count
- **Weave the thread**: local sentence-overlap synthesis — *Where they agree* and *Only one of them said*
- **Check each other**: each model critiques the other two
- **Score replies**: first reply +1, most words +3, your Best pick +2 (kept in localStorage)
- **Speak thread**, **Copy**, **Download / Share .md** (iOS share sheet → Save to Files / Google Drive), **Email thread**
- **Library** of past questions (searchable, last 50)
- API keys and model ids live only in this browser (defaults `gpt-4.1`, `claude-sonnet-4-6`, `grok-4`)

## Files

```
index.html             the whole app (no dependencies)
manifest.webmanifest   PWA manifest
sw.js                  service worker (offline app shell; never caches API calls)
icon.svg               app mark (three braided threads, spindle, shears)
icons/                 192/512 PNGs, maskable 192/512, apple-touch-icon 180, favicon
fonts/                 Share Tech Mono (SIL OFL, self-hosted for offline)
shots/                 iPhone screenshots (393x852 @3x)
```

## Install on iPhone

Host the folder on a same-origin HTTPS host (GitHub Pages works: Settings → Pages → deploy from branch). Open the URL in Safari → Share → **Add to Home Screen**.

> Service workers require same-origin hosting. GitHub Pages works; serving through the jsDelivr CDN renders the page but the service worker/offline install will not register properly there.

Notes: the mic works best in Safari itself (speech recognition can be limited in home-screen mode). If a provider blocks a browser call, paste that reply into its panel and weave.

Agreement is the safer core. A point only one model makes is a lead to check, not a fact.
