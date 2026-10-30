# Ainos — clickable prototype

A presentable prototype of the finished Ainos, for demos and a 2-minute video. It runs entirely in the browser on sample data: no backend, no database, no accounts, no npm packages, no build step. The "Prototype · sample data" badge stays in a corner.

**Live:** https://ainos-prototype.vercel.app (Vercel project `ainos-prototype`, separate from the Ainos app). Redeploy after changes: `cd prototype && npx vercel@64.3.1 deploy --prod --scope rhidayas-projects`.

## Run it locally

Serve this folder with any static file server, then open it in Chrome or Edge:

```bash
cd prototype
npx serve .                 # or: python -m http.server 8080
```

(Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.) Nothing is sent anywhere. The setlist and language are kept in this browser's `localStorage`; sign out and back in to start fresh, or clear site data.

**YouTube:** `js/config.js` holds the id of Victory Worship's official "Carry My Cross" lyric video (eov9K7ALYKk, from their own channel). It plays only in YouTube's own embedded player.

## What's real and what's sample

- **Hymns:** four public-domain hymns (Amazing Grace, It Is Well with My Soul, Holy, Holy, Holy, Abide with Me). They are synthesized by Ainos's own generator (`scripts/hymns.js`, original tunes, words as printed in pre-1929 hymnals) and stored as WAV files in `audio/`.
- **Synced lyrics:** each line's time is the exact moment its first note is rendered in the audio. The times come from the same melody data, and an automated check against the audio's note onsets put every line within 85 ms.
- **Scripture:** passages from the World English Bible (public domain, eBible.org), hard-coded with attribution.
- **"Carry My Cross":** shown only as Victory Worship's official YouTube embed. Its lyrics never appear and it never becomes slides.
- **Church:** "Grace Fellowship", its setlist, and anything you add are sample data in memory.
- **Languages:** English and Nepali are complete. The other four appear in the menu as "coming soon".

## 2-minute click-through

| Time | Do this | Say this |
|---|---|---|
| 0:00 | Open the site. | "Ainos: worship and praise, in every tongue." |
| 0:05 | Click **Listener demo**. | Home: hymns, playlists, recently played. |
| 0:12 | Click **Amazing Grace**. The player bar starts. | "Public-domain hymns, played from the original tunes." |
| 0:20 | Click the **Lyrics** button (microphone). | Lines light up in time and scroll by themselves. |
| 0:30 | Click a line further down. | "Tap a line to jump there." |
| 0:38 | Click the **now-playing** button, open a **Scripture** reference. | "Every hymn shows the Scripture it draws on, with the World English Bible text." |
| 0:48 | Language menu → **नेपाली**. | The whole interface switches to Nepali. Switch back to English. |
| 0:58 | **Search**, type `carry my cross`, play the result. | "Search also finds official worship videos. They play in YouTube's own player." |
| 1:10 | Sign out → **Church demo**. | "For churches: this Sunday's setlist." |
| 1:15 | Move a song up, open **Paste lyrics** → **Try a sample** → **Add to setlist**. | "Paste lyrics and Ainos splits verses and chorus into slides." |
| 1:30 | Click **Present** → **Presenter view** → **Automatic** → **Start**. | The second window shows the slides; this one shows current, next and every slide. |
| 1:40 | Let the hymn play. | "Slides advance with the music." Click through the Scripture reading. |
| 1:55 | Press **End**. | "Ainos: worship, the Word and the words, together." |

**Present on this screen** instead: a fullscreen slideshow, with arrows / PageUp / PageDown / Space / click to move, and Esc to exit.

**Two screens:** in Presenter view, Chrome and Edge can place the slides window on the second display (allow "window management" when asked). Otherwise drag that window to the projector and click it to go fullscreen.

## Files

- `index.html`, `present.html` (the audience window)
- `css/`: `base.css` (look, layout), then one file per feature
- `js/`:
  - `main.js`: routes and shell
  - `state.js`: in-memory state
  - `player.js`: audio
  - `i18n.js` and `strings/`: UI text, English and Nepali
  - `slides.js`: lyrics → slides, pasted-text parser
  - `views/`: login, home, search, church
  - `components/`: sidebar, player bar, now playing (lyrics, Scripture, YouTube)
  - `present/`: dialog, stage, audience window
  - `data/`: hymns with timed lyrics and Scripture, videos
  - `config.js`: the YouTube id to fill in
- `audio/`: the four hymn recordings
