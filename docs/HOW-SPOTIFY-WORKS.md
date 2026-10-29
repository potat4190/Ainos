# How Spotify works: the evidence

This report explains how Spotify delivers music, and backs each claim with evidence. Ainos (the app in this folder) copies each mechanism. The last sections map every one to the Ainos code that implements it.

**How the evidence was gathered (October 2026)**

1. **Spotify's own publications.** Its engineering paper on streaming (IEEE P2P 2010), its engineering blog, its patents and its developer docs.
2. **Spotify's official support pages.** Bitrates, loudness and plan limits.
3. **First-hand inspection** of the Spotify desktop client installed on this PC (version **1.3.5.3058**, in `%APPDATA%\Spotify`). Read-only: file listings, version numbers, and short strings from its UI bundle. No account data was read.
4. **Secondary sources** (press, interviews). These are labelled as such.

Each claim carries one of these labels: **[Primary]** Spotify-authored, **[Official]** Spotify support/docs, **[Observed]** seen on this machine, **[Secondary]** third-party reporting, **[Inferred]** my reading of the evidence.

---

## Summary

| Layer | What Spotify does | Evidence | Confidence |
|---|---|---|---|
| Client | Desktop app is a web app (React-style bundle) running in Chromium Embedded Framework | `libcef.dll` (285 MB, Chromium 151) + 592-file `xpui` bundle on this PC | High |
| Streaming | Audio is split into chunks; the first seconds come from a server; the client seeks with a seek table | 2010 paper; `seektable` + CDN `base_urls` in today's client | High |
| Latency | Prefetches the next track before the current one ends | 2010 paper: 30 s / 10 s; latency 390 → 265 ms | High |
| Cache | Encrypted on-disk cache with LRU eviction | 2010 paper | High (for 2010) |
| Quality | 24 / 96 / 160 / 320 kbps; lossless FLAC up to 24-bit/44.1 kHz for Premium | Support page; 2025 launch | High |
| Loudness | Normalizes to −14 LUFS (Loud −11, Quiet −19) per ITU 1770 | Spotify for Artists page | High |
| Events | Clients send events; pipeline moved from Kafka to Google Cloud Pub/Sub | Spotify engineering blog | High |
| Streams | A play counts as a stream after 30 seconds | Spotify staff answer | High |
| Recommendations | Collaborative filtering on implicit feedback + audio models + nearest-neighbour search | Patent, papers, blog, open-source libraries | High (methods), Medium (current mix) |
| Connect | Persistent push connection ("dealer") + a connect-state service | Strings in today's client | Medium (internals not documented) |
| Business | Freemium; free tier has limits | Support + press | High |

---

## 1. The desktop client is a web app

**[Observed]** The Spotify folder on this PC contains a full Chromium runtime:

| File | Size | What it is |
|---|---|---|
| `libcef.dll` | 285 MB | Chromium Embedded Framework, version `151.3.18+chromium-151.0.7922.138` |
| `v8_context_snapshot.bin` | 18 MB | V8 JavaScript engine snapshot |
| `chrome_100_percent.pak`, `resources.pak`, `icudtl.dat` | — | Standard Chromium resources |
| `Spotify.exe` / `Spotify.dll` | 4 MB / 43 MB | Native shell: audio, cache, networking |
| `Apps\xpui\` | 592 files, 51 MB | The UI: 194 JavaScript files, 99 CSS, 124 SVG, 21 web fonts |

The UI's `index.html` begins like a website and opens connections to Spotify's backend hosts before anything else loads:

```
<html lang="en" dir="ltr" class="encore-dark-theme encore-layout-themes">
<link rel="preconnect" href="https://api.spotify.com">
<link rel="preconnect" href="https://apresolve.spotify.com">
<link rel="preconnect" href="https://spclient.wg.spotify.com">
<link rel="preconnect" href="https://i.scdn.co">
...
```

`apresolve` returns which access points to connect to, `spclient` is the client API gateway, and `i.scdn.co` serves images. "Encore" is the name of Spotify's design system (it appears in 17 files).

**[Observed]** A dependency manifest embedded in the bundle lists `"shaka-player": "4.4.2"` (Google's open-source adaptive media player), `protobufjs` (Protocol Buffers, Spotify's wire format) and `@spotify-internal/event-sender`.

**[Inferred]** Spotify ships one web UI to desktop and the browser (open.spotify.com), and native code handles audio and the disk cache. This is why the desktop app and the web player look identical.

---

## 2. Web API & catalog

**[Official]** Spotify exposes a public REST Web API (`api.spotify.com/v1`) with JSON objects for tracks, albums, artists and playlists. Every object has a 22-character base-62 id and a URI like `spotify:track:<id>`. Third-party apps authorize with OAuth 2.0. Spotify recommends the *Authorization Code with PKCE* flow for apps that can't keep a secret. [Spotify: Authorization Code with PKCE Flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)

**[Observed]** The first-party client also uses GraphQL with *persisted queries*. It sends a SHA-256 hash of a pre-registered query instead of the query text:

```
function c(e){return{persistedQuery:{version:1,sha256Hash:e.sha256Hash}}}
```

**[Observed]** The client also calls internal "webgate" services by name. One plugin adds platform headers only to these:

```
include:e=>/@webgate\/(manifests|director|track-playback|connect-state)\//.test(e),
optionsOverrides:{headers:{"App-Platform":a,"Spotify-App-Version":_}}
```

---

## 3. Streaming: how audio reaches you

The most detailed public description is Spotify's own paper: **Kreitz & Niemelä, "Spotify — Large Scale, Low Latency, P2P Music-on-Demand Streaming", IEEE P2P 2010** ([PDF](https://www.csc.kth.se/~gkreitz/spotify-p2p10/)). Both authors worked at Spotify.

**[Primary]** Key facts, quoted:

- Codec: *"Audio streams are encoded using Ogg Vorbis with a default quality of q5, which has variable bitrate averaging roughly 160 kbps. Users with a premium subscription can choose … q9 quality, averaging roughly 320 kbps."*
- One connection: *"Between a pair of hosts a single TCP connection is used, and the application protocol multiplexes messages over the connection … messages needed to support interactive browsing are prioritized over bulk traffic."*
- Fast start: *"Unless the client had the data cached, it makes an initial request to the server asking for approximately 15 seconds of music, using the already open TCP connection."*
- Chunks: peer-to-peer transfers used *"chunks of 16 kB"*.
- Throttling: *"While streaming from a server, clients throttle their requests such that they do not get more than approximately 15 seconds ahead of the current playback point."*
- Emergency mode: if *"less than 3 seconds of audio [is] buffered during playback, the client pauses uploading data to its peers."*
- Seeking: *"The Ogg Vorbis format offers limited support for seeking in a streaming environment, so Spotify adds a custom header to all their files to better support seeking."*
- Results: median playback latency **265 ms**. Only **8.8 %** of music data came from Spotify's servers; the rest came from peers or the local cache.

**[Secondary]** Spotify later dropped peer-to-peer. In 2014 a spokesperson said the company was *"gradually phasing out the use of our desktop P2P technology"* because its own server network could carry the load ([SlashGear, citing TorrentFreak](https://www.slashgear.com/spotify-phasing-out-use-of-p2p-16325556/)).

**[Observed]** Today's client still fetches by seek table. The player parses a manifest whose files list fallback CDN base URLs:

```
_parseManifest(e){ … if(!s)return(o=new t9(er.FILE_MALFORMED_SEEKTABLE,"Malformed seektable: no contents.")) …
this._fallbackURLs=e.base_urls.slice(),this._baseURL=…this._fallbackURLs.shift()
```

**[Observed]** In the browser-based player, encrypted audio plays through Encrypted Media Extensions with Widevine DRM (`com.widevine.alpha`, `widevinePersistentLicenseSupported`). The player checks support for `audio/webm` and `audio/mp4`.

---

## 4. Prefetching the next track

**[Primary]** From the 2010 paper, §II-C:

> *"The clients begin searching the peer-to-peer network and start downloading the next track when 30 seconds or less remain of the current track. When 10 seconds or less remain of the current track, the client prefetches the beginning of the next track from the server if needed."*

The paper also measured what happens without prefetching. A client bug once disabled it for a few weeks:

> *"During a week when prefetching was disabled the median playback latency was 390 ms, compared with the median latency over the current measurement period of 265 ms. Furthermore, the fraction of track playbacks in which stutter occurred was 1.8%, compared to the normal rate of 1.0%."*

61 % of plays happen in a predictable sequence: the previous track ended or the user pressed *next*. After a user had listened to all but the last 10 s or 30 s of a track, the next scheduled track played in 94 % and 92 % of cases, respectively.

---

## 5. Caching

**[Primary]** 2010 paper, §II-A:

> *"The cache can store partial tracks … Cached content is encrypted and cannot be used by other players. The default setting in the clients is for the maximum cache size to be at most 10% of free disk space … but at least 50 MB and at most 10 GB … Cache eviction is done with a Least Recently Used (LRU) policy."*

At the time, 56 % of installs had a maximum cache of 5 GB or more (roughly 1,000 tracks).

---

## 6. Quality tiers

**[Official]** [Spotify support: audio quality](https://support.spotify.com/us/article/audio-quality/):

| Setting | Bitrate | Plan |
|---|---|---|
| Low | ~24 kbit/s | Free & Premium |
| Normal | ~96 kbit/s | Free & Premium |
| High | ~160 kbit/s | Free & Premium |
| Very high | ~320 kbit/s | Premium |
| Lossless | up to 24-bit/44.1 kHz FLAC | Premium |
| Web player | AAC 128 kbit/s (Free), 256 kbit/s (Premium) | — |

"Automatic" depends on the network connection.

**[Secondary]** Lossless rolled out to Premium in September 2025 at no extra cost ([Spotify newsroom tag](https://newsroom.spotify.com/tag/higher-quality), [audioXpress](https://audioxpress.com/news/spotify-finally-launches-24-bit-lossless-streaming)).

**[Observed]** The client bundle mentions `FLAC` in 75 files.

---

## 7. Loudness normalization

**[Official]** [Spotify for Artists: Loudness normalization](https://support.spotify.com/artists/article/loudness-normalization/):

- *"We adjust tracks to -14 dB LUFS, according to the ITU 1770 standard."*
- Premium listeners choose *"Loud: -11dB LUFS · Normal: -14dB LUFS · Quiet: -19dB LUFS"*.
- *"Positive gain is applied to softer masters so the loudness level is -14 dB LUFS … We consider the headroom of the track, and leave 1 dB headroom for lossy encodings."*
- *"The limiter's set to engage at -1 dB (sample values), with a 5 ms attack time and a 100 ms decay time"* (used for the Loud setting).
- *"The web player and 3rd-party devices (like TVs or speakers) don't use loudness normalization."*

**[Observed]** "normalization" and "loudness" appear in 77 and 80 files of the client bundle.

---

## 8. Events: the data pipeline

Every play, pause, skip and error on a Spotify client becomes an event, and the events feed royalties, charts and recommendations.

- **[Primary]** In 2015 Spotify decided to move its infrastructure to Google Cloud Platform and redesigned event delivery around Cloud Pub/Sub. Before the switch it load-tested Pub/Sub at 2 million messages per second. The old Kafka-based system was turned off in February 2017. ([Spotify's Event Delivery – The Road to the Cloud, Part II](https://engineering.atspotify.com/2016/3/spotifys-event-delivery-the-road-to-the-cloud-part-ii); [Google Cloud blog](https://cloud.google.com/blog/products/gcp/spotifys-journey-to-cloud-why-spotify-migrated-its-event-delivery-system-from-kafka-to-google-cloud-pubsub))
- **[Primary]** By the end of Q1 2019 the system handled *"more than 8 million events/s at peak globally"* ([Spotify's Event Delivery – Life in the Cloud](https://engineering.atspotify.com/2019/11/spotifys-event-delivery-life-in-the-cloud)).
- **[Primary]** Events are delivered at least once and land in hourly buckets for downstream batch jobs. In 2021 Spotify migrated again, to a newer Event Delivery Infrastructure ([Changing the Wheels on a Moving Bus](https://engineering.atspotify.com/2021/10/changing-the-wheels-on-a-moving-bus-spotify-event-delivery-migration/)).
- **[Observed]** The client bundle depends on `@spotify-internal/event-sender`. A client module reports `connection_id`, `authenticated` and `transport_connect` timing events.

---

## 9. Streams: the 30-second rule

**[Official]** A Spotify staff answer on the community forum: *"Streams are only counted when a listener has played over 30 seconds of a song, whether listening online or offline."* Spotify pays rights holders, and they pay artists under their own agreements ([Spotify Community](https://community.spotify.com/t5/App-Features/Offline-Listenings-and-Royalties/td-p/5349610); [Loud & Clear](https://loudandclear.byspotify.com/)).

---

## 10. Recommendations

Spotify has no star ratings. It learns taste from **implicit feedback**: what you stream, skip, save and add to playlists.

- **[Primary]** **Collaborative filtering by matrix factorization.** Spotify engineer Christopher Johnson published *Logistic Matrix Factorization for Implicit Feedback Data* (NIPS 2014). Spotify patented it as *"System and method for logistic matrix factorization of implicit feedback data, and application to media environments"* ([US 10,380,649](https://patents.google.com/patent/US10380649)). The patent describes gathering streaming usage into an observation matrix and estimating latent factors for users and items. The classic baseline it builds on is weighted ALS for implicit feedback (Hu, Koren & Volinsky, 2008).
- **[Primary]** **Audio models for the cold-start problem.** Sander Dieleman's 2014 Spotify internship trained convolutional networks on mel-spectrograms (599 frames × 128 bins) to predict listening-based factors from audio. This lets new or obscure songs, which nobody has played yet, be recommended ([Recommending music on Spotify with deep learning](https://sander.ai/2014/08/05/spotify-cnns.html)).
- **[Primary]** **Nearest-neighbour search.** Spotify open-sourced **Annoy** in 2013 and its successor **Voyager** (HNSW-based, Python & Java) in October 2023 to find similar items among vectors at catalog scale ([Introducing Voyager](https://engineering.atspotify.com/introducing-voyager-spotifys-new-nearest-neighbor-search-library), [GitHub](https://github.com/spotify/voyager)).
- **[Secondary]** **Discover Weekly** (launched 2015) mixes these signals. Its creator, Edward Newett, described modelling relationships between tracks from users' playlists, and each user's taste from their listening. It refreshes every Monday ([Quartz/O'Reilly interview](https://oreil.ly/3ZQnQ)).

---

## 11. Connect: controlling one device from another

Spotify Connect lets you start music on your phone and play it on a laptop or speaker, then move it between devices without losing your place. Spotify doesn't document the internals publicly. Here is what the client shows:

- **[Observed]** A plugin named `dealer` provides the connection (`getPluginAPI("dealer")`, `connection_id`), the persistent push channel the server uses to reach the client.
- **[Observed]** `connect-state` and `track-playback` are webgate services the client calls (see §2). Constants include `CONNECT_API="connect-api"` and `TRACK_PLAYBACK="track-playback"`.
- **[Inferred]** Each device keeps a push connection open. One device is "active". The server holds the shared player state (track, position, queue) and relays commands. A transfer hands that state to the new device, which resumes from the same position.

---

## 12. Business model

- **[Official]** Free and Premium plans. Premium unlocks the higher-quality tiers (§6) and loudness level choice (§7).
- **[Secondary]** On mobile, once free users use up a daily allowance of on-demand time, they are *"limited to six-skips per hour"* (September 2025 change, [MobileSyrup](https://mobilesyrup.com/2025/09/16/spotifys-free-users-can-now-pick-songs-but-there-is-a-small-catch/)).
- **[Primary]** In the early years, peer-to-peer delivery kept bandwidth costs down (only 8.8 % of data came from servers, §3).

---

## 13. How Ainos implements each mechanism

| Spotify mechanism | Ainos implementation | Where in the code |
|---|---|---|
| Web API, ids, URIs | REST JSON API, 22-char base-62 ids, `ainos:track:<id>` URIs | `server/app.js`, `server/catalog.js` |
| Chunked streaming + seek table | Signed media URLs + HTTP Range; manifest with `seektable` (16 KB chunks, bytes/second) and `cdn_urls` | `server/http.js` (`serveRange`), manifest route in `server/app.js` |
| Signed CDN URLs | HMAC-SHA256 signature + expiry on every media URL | `server/auth.js` (`signMediaPath`) |
| Prefetch at −30 s | Second audio "deck" loads the next track at 30 s remaining; instant swap | `public/js/player.js` (`#prefetchNext`) |
| Latency & stutter metrics | Click-to-first-audio and buffer underruns measured, reported as events | `player.js` (`#onPlaying`, `waiting` listener) |
| Encrypted LRU cache | Service worker LRU cache (60 MB) + pinned offline downloads, range-served from cache | `public/sw.js` |
| Quality tiers | Low 176 kbps / High 353 kbps; every account can stream High (single All-Access plan); "Automatic" uses Network Information API | manifest route, `player.js` (`#quality`) |
| Loudness normalization | BS.1770-4 meter (verified: −3.01 LUFS on the reference tone); Loud/Normal/Quiet targets; gain capped at −1 dBFS peak | `server/loudness.js`, `player.js` (`normalizationGainDb`) |
| Event delivery | Batched client events → hourly NDJSON buckets (local) + the database (SQLite locally, Postgres when hosted); `sendBeacon` on page close | `server/events.js`, `player.js` (`flush`) |
| 30-second rule | `play_end` with ≥ 30 000 ms ⇒ a stream | `server/events.js` |
| Collaborative filtering | Weighted ALS on streams + likes (8 factors, λ = 10, chosen by a parameter sweep) scores tracks for each user; co-listening cosine powers track-to-track similarity (it beat ALS item factors on this small catalog: 2.76 vs 2.06 same-genre tracks in the top 3) | `server/recommend.js` |
| Audio-based cold start | Audio-feature vectors blended in, weighted by how much play data a track has | `server/recommend.js` (`similarTracks`) |
| Nearest-neighbour search | Exact cosine search (fine at this catalog size; Voyager/Annoy needed at millions) | `server/recommend.js` |
| Discover Weekly / Daily Mix / Radio | Weekly snapshot of unheard tracks (max 2 per artist); per-genre daily mixes; seed + neighbours | `server/recommend.js` |
| Connect | Server-Sent Events push channel per device; state fan-out, remote commands, transfer with position | `server/connect.js`, `public/js/connect.js` |
| Freemium | Not implemented: Ainos has one All-Access plan for everyone (High quality, unlimited skips) | manifest route in `server/app.js` |
| Web UI in a shell | Single-page web app (no framework), installable PWA | `public/` |

**Where Ainos deliberately differs**

- **Audio:** Ainos ships 16-bit PCM WAV that it synthesizes itself (Node has no built-in lossy encoder, and real songs can't be redistributed). Spotify uses Ogg Vorbis, AAC and FLAC.
- **No DRM:** Ainos protects files with signed, expiring URLs only. Spotify uses Widevine on the web and an encrypted cache.
- **No peer-to-peer:** Spotify itself dropped it in 2014.
- **Recommendation scale:** 41 tracks and 301 users in Ainos versus 100M+ tracks at Spotify. The algorithms are the same family; the infrastructure (Pub/Sub, Dataflow, Voyager indexes) is replaced by SQLite (or Postgres when hosted) and in-process code.
- **Loud mode:** Ainos caps gain at −1 dBFS peak instead of running a limiter, so very quiet, peaky masters may stay slightly below target.

---

## 14. What I could not verify

- Spotify's current server-side streaming protocol (beyond what the client bundle reveals) and current CDN vendors.
- The exact current blend of signals behind Discover Weekly. Spotify has published the components, not the recipe.
- Spotify Connect's wire protocol. §11 is based on names in the client code plus behaviour.
- Whether the six-skips rule still applies everywhere. Press reports conflict (§12).

---

## Sources

**Spotify-authored**
- Kreitz, G. & Niemelä, F. (2010). *Spotify — Large Scale, Low Latency, P2P Music-on-Demand Streaming.* IEEE P2P'10. https://www.csc.kth.se/~gkreitz/spotify-p2p10/
- Goldmann, M. & Kreitz, G. (2011). *Measurements on the Spotify Peer-Assisted Music-on-Demand Streaming System.* https://www.csc.kth.se/~gkreitz/spotify-p2p11/
- Spotify Engineering: *Event Delivery – The Road to the Cloud (Part II)*, 2016. https://engineering.atspotify.com/2016/3/spotifys-event-delivery-the-road-to-the-cloud-part-ii
- Spotify Engineering: *Event Delivery – Life in the Cloud*, 2019. https://engineering.atspotify.com/2019/11/spotifys-event-delivery-life-in-the-cloud
- Spotify Engineering: *Changing the Wheels on a Moving Bus*, 2021. https://engineering.atspotify.com/2021/10/changing-the-wheels-on-a-moving-bus-spotify-event-delivery-migration/
- Spotify Engineering: *Introducing Voyager*, 2023. https://engineering.atspotify.com/introducing-voyager-spotifys-new-nearest-neighbor-search-library
- Dieleman, S. (2014). *Recommending music on Spotify with deep learning.* https://sander.ai/2014/08/05/spotify-cnns.html
- Johnson, C. (2014). *Logistic Matrix Factorization for Implicit Feedback Data.* NIPS 2014; Spotify patent US 10,380,649. https://patents.google.com/patent/US10380649

**Spotify official documentation**
- Audio quality: https://support.spotify.com/us/article/audio-quality/
- Loudness normalization: https://support.spotify.com/artists/article/loudness-normalization/
- Web API, Authorization Code with PKCE: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Stream counting (staff answer): https://community.spotify.com/t5/App-Features/Offline-Listenings-and-Royalties/td-p/5349610

**Secondary**
- Google Cloud blog on Spotify's Pub/Sub migration: https://cloud.google.com/blog/products/gcp/spotifys-journey-to-cloud-why-spotify-migrated-its-event-delivery-system-from-kafka-to-google-cloud-pubsub
- SlashGear on P2P phase-out (citing TorrentFreak): https://www.slashgear.com/spotify-phasing-out-use-of-p2p-16325556/
- audioXpress on lossless launch: https://audioxpress.com/news/spotify-finally-launches-24-bit-lossless-streaming
- MobileSyrup on free-tier skip limits: https://mobilesyrup.com/2025/09/16/spotifys-free-users-can-now-pick-songs-but-there-is-a-small-catch/
- InfoQ on Voyager: https://www.infoq.com/news/2023/11/spotify-ann-voyager/

**First-hand inspection**
- Spotify desktop client 1.3.5.3058 for Windows, `%APPDATA%\Spotify` (CEF 151.3.18 / Chromium 151.0.7922.138), inspected read-only on 2026-10-20.
