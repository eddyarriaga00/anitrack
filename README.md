# AniTrack

An anime hub: browse shows, follow the weekly airing schedule and track every episode, synced with **MyAnimeList**.

**Live site:** https://eddyarriaga00.github.io/anitrack/

## Two ways to use it

| | GitHub Pages (live site) | On your computer (`node server.js`) |
|---|---|---|
| Browse, schedule, show pages | ✅ | ✅ |
| Track episodes (saved in your browser) | ✅ | ✅ |
| Export to MyAnimeList (import file) | ✅ | ✅ |
| **Live MyAnimeList sync** | — | ✅ |

GitHub Pages only hosts static files. MyAnimeList's API requires a small server for login, and browsers can't call it directly, so live MAL sync only works with `server.js` running.

## Features

- **Home:** a rotating trending banner, your Continue watching shows with "N new" badges, shows airing in the next 24 hours, this season, coming soon, popular and top rated
- **Browse filters:** airing status, minimum score (7+, 8+, 9+) and "Hide my list", on top of season, year, format, genre and sort. Light, dark or system theme with the ◐ button.
- **Browse:** pick a season (with ‹ Prev / Next › buttons), year, format, genre and sort, then load more. Every filter is in the URL, so you can bookmark or share a view.
- **Schedule:** the next 7 days of episodes in your timezone. Shows on your list are highlighted, and "My shows" filters to just yours.
- **Instant search:** results appear as you type, with arrow-key navigation and Enter to open
- **Quick add:** a ＋ on every poster adds the show to Plan to watch, and shows already on your list get a ✓
- **Because you watched…:** recommendations on Home based on shows you rated highly, skipping ones already on your list
- **Character pages:** age, birthday, Japanese voice actor, a bio with spoilers hidden, and every show they appear in
- **Franchise timeline:** prequels, sequels and spin-offs in release order, with "You're here" on the current show
- **Studio pages:** every show from a studio, with its best-rated titles
- **Show pages:** synopsis, tags, trailer, characters with Japanese voice actors, related shows, recommendations, official "Where to watch" links, a next-episode countdown, official episode thumbnails when available, and a Share button
- **Tracking:**
  - One tap for "✓ Watched episode N", or tap any episode number. Set status and score too.
  - Shows are marked completed automatically on the last episode.
  - Every card on My List has a **+1 ep** button.
- **▶ Watch button:** each show page has "Watch EP N on Crunchyroll" (or your service). It links straight to the episode when the service provides episode links. You can choose a service per show, or set a default for every show on My List. When you come back, AniTrack asks "Finished episode N?" so logging it takes one tap.
- **Dates, rewatches and notes:** start and finish dates fill in automatically (and can be edited), plus a rewatch count and private notes. All of these sync to MAL when connected.
- **Watch history:** a 30-day episode chart, your day streak and a recent-activity feed
- **Share your list:** "🔗 Share my list" copies a link anyone can open on the live site, with your statuses, progress, scores and how many shows they share with you
- **Table view:** a compact list on My List with inline −/+ episode buttons and score pickers
- **Calendar export:** on the Schedule page, "📅 Add my shows to calendar" downloads an .ics file with your shows' air times and a 10-minute reminder
- **Search and filter your list:** a search box and format filter on My List
- **Schedule Watch links:** each airing entry has a ▶ Watch link to its show page
- **My List:** stats (shows, episodes, days watched, mean score), a status breakdown, your top genres, status tabs with counts, and sorting by recent, new episodes, progress, score or title
- **Works without setup:** your list is saved in your browser right away. Once you connect MAL, a **Sync to MAL** button copies it over.
- **Export for MAL:** produces an XML file to upload at myanimelist.net/import.php, so you can update MAL even without API setup. **Backup** and **Restore** use a JSON file.
- **🎲 Surprise me:** opens a random popular show
- **Keyboard shortcuts:** `/` search · `g h` home · `g b` browse · `g s` schedule · `g l` my list · `g r` random · `←/→` move the banner · `?` list shortcuts
- **Installable:** can be installed as an app from Chrome or Edge (address bar install icon), or added to your phone's home screen. App files are cached for offline use.

Show data comes from the AniList public API. Tracking goes to MyAnimeList through the small local server.

## Run

You need Node 18 or newer. Nothing to install.

```bash
cd ~/Projects/AniTrack
node server.js
```

Open http://localhost:3000 and leave that Terminal window open while you use the site.

## Turn on MAL sync (one-time)

1. Go to https://myanimelist.net/apiconfig and click **Create ID**.
2. App Type: **web**. App Redirect URL: `http://localhost:3000/auth/callback`
3. Copy `.env.example` to `.env` and paste in your **Client ID**. Also add the Client Secret if MAL gave you one.
4. Restart `node server.js` and click **Connect MAL**. If you tracked shows before connecting, click **Sync to MAL** on My List.

Your login is saved in `tokens.json` on your computer and renews automatically. It is in `.gitignore`, so it won't be committed.

## Deploying

Every push to `main` deploys the `public/` folder to GitHub Pages using `.github/workflows/pages.yml`.

## Files

- `server.js`: serves the site, handles MAL login, and passes your list updates to MAL
- `public/app.js`: all site logic (pages, tracking, schedule). The "Where to watch" panel is built in `pageDetail()`.
- `public/styles.css`, `public/index.html`: layout and look
- `public/sw.js`, `public/manifest.webmanifest`, `public/icon.svg`: installable-app support
