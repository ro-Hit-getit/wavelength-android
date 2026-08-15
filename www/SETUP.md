# Wavelength — Cloud Sync Setup (Supabase)

This update replaces `localStorage` with a Supabase-backed cloud
database for your music library, favorites, and recently played
songs, so the same account shows the same library on every device.
Everything else (the player, UI, search, queue, shuffle, repeat,
responsive layout) is unchanged.

Volume, shuffle state, and repeat mode stay in each browser's
`localStorage`, as intended — only the things that should follow
your account (library, favorites, recently played) live in Supabase.

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**. Pick any name/region and a database password
   (you won't need that password for this app — only for direct DB
   access).
3. Wait for the project to finish provisioning (~1–2 minutes).

## 2. Run the database setup SQL

1. Open **`supabase-setup.sql`** (included alongside this file).
2. In your Supabase project, go to **SQL Editor → New query**.
3. Paste the entire contents of `supabase-setup.sql` and click **Run**.

This creates three tables — `songs`, `favorites`, `recently_played` —
each with Row Level Security enabled and policies that restrict every
read/write to `auth.uid() = user_id`. Nothing is publicly readable or
writable.

## 3. Enable email/password auth

Email/password sign-in is on by default in Supabase. If you want to
skip email confirmation while testing (recommended for personal use):

1. Go to **Authentication → Providers → Email**.
2. Turn **Confirm email** off (or leave it on if you'd rather confirm
   via the email link each time you sign up).

## 4. Get your Project URL and anon key

1. Go to **Project Settings → API**.
2. Copy the **Project URL**.
3. Copy the **anon / public** key under **Project API keys**.
   ⚠️ Do **not** copy the `service_role` / secret key — that one must
   never appear in frontend code.

## 5. Paste them into `script.js`

Open `script.js` and find this block near the top:

```javascript
// =====================================
// SUPABASE CONFIGURATION
// =====================================

const SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_PUBLISHABLE_KEY";
```

Replace the two placeholder strings with the values from step 4, e.g.:

```javascript
const SUPABASE_URL = "https://abcdefghijklmno.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
```

Save the file. That's the only code change required to connect your
own Supabase project.

## 6. Run the site

Same as before — open the `player` folder in VS Code and run it with
the **Live Server** extension (right-click `index.html` → "Open with
Live Server"). Opening via `file://` directly may block the metadata
fetch and the Supabase requests in some browsers, so Live Server (or
any static host) is the reliable option.

## 7. Deploy (optional)

Push the folder to a GitHub repository and enable **GitHub Pages**
(**Settings → Pages → deploy from branch**). No build step is needed —
it's a static site. The Supabase URL/anon key are safe to ship
publicly because Row Level Security enforces who can read or write
what.

---

## What changed under the hood

| Data                | Before                | Now                                  |
|---------------------|------------------------|---------------------------------------|
| Music library        | `localStorage`         | `songs` table in Supabase             |
| Favorites             | `localStorage`         | `favorites` table in Supabase         |
| Recently played       | `localStorage`         | `recently_played` table (latest 20)   |
| Playback queue         | in-memory              | in-memory (unchanged, per spec)       |
| Volume/shuffle/repeat  | `localStorage`         | `localStorage` (unchanged, per spec)  |

- **Duplicate prevention:** the `songs` table has a unique constraint
  on `(user_id, youtube_id)`. If you paste a link for a song already
  in your library, the app shows *"This song is already in your
  library."* instead of inserting a duplicate.
- **Realtime sync:** the app subscribes to Postgres changes on
  `songs`, `favorites`, and `recently_played` filtered to your user
  ID, so a song added on one device appears on another automatically,
  without a page refresh.
- **Offline/network errors:** if a Supabase request fails (no
  internet, project paused, etc.), the app shows a banner —
  *"Unable to connect to your music library. Check your internet
  connection and try again."* — and keeps whatever was already loaded
  in memory rather than clearing your library.
- **Demo songs:** three demo links are offered only as quick-add
  suggestions on the empty-library screen. They are not part of your
  cloud library until you click one, at which point they're added the
  same way any pasted link would be.

---

## Testing cloud sync across two devices

**Device A (e.g. your laptop):**
1. Open the site → sign up with an email + password → you land on
   your (empty) library.
2. Click **Add Song**, paste a YouTube link, and add it.
3. Confirm it shows up in **My Library**.

**Device B (e.g. your phone, or a different browser):**
1. Open the same site URL.
2. Log in with the **same email and password**.
3. The song you added on Device A should appear automatically in the
   library — no manual refresh needed if both devices are open at the
   same time (thanks to Realtime); otherwise it appears as soon as
   Device B loads or you switch back to the tab.
4. Favorite a song on Device B, then check Device A — the heart
   should sync there too.

If a song doesn't appear:
- Confirm you're logged into the **same account** (check the email
  shown at the bottom of the sidebar).
- Check the browser console for errors — most commonly this means the
  `SUPABASE_URL`/`SUPABASE_ANON_KEY` values weren't saved, or the SQL
  setup script wasn't run.
- Use the **Retry** button on the "Unable to connect" banner if you
  see one.

---

## Security notes

- Only the public **anon** key is used in `script.js`. It has no
  power on its own — every query is filtered by Row Level Security
  policies that check `auth.uid() = user_id` on the server side.
- The **service_role** key is never used or referenced anywhere in
  this project. Do not add it to `script.js` or any frontend file.
- A signed-out visitor sees only the login/signup screen — the
  library, player, and all data views are hidden until
  `supabase.auth.getSession()` confirms a valid session.


## Local Music (offline)

Wavelength can also play audio files stored locally on the current device. Use **Scan Local Music** and choose your Music/audio folder when the browser supports directory access. On browsers without directory access, the app falls back to selecting multiple audio files.

Local audio is stored in **IndexedDB on that device/browser** and is never uploaded to Supabase. It remains available offline after the page is reopened, subject to browser storage limits. Local songs do not sync their audio files to another device.

A normal website cannot silently scan the entire device filesystem; the user must grant access through the browser's file picker.

## Mobile notification / lock-screen controls
Wavelength now uses the browser Media Session API when available. On supported Android browsers (typically Chrome) and when the site is served over HTTPS, local audio playback can expose the song title/artist and play/pause, previous, next, and seek controls in the phone's media notification/lock screen. YouTube playback also registers Media Session metadata/actions on a best-effort basis; browser/YouTube iframe policies can limit notification behavior.

## Separate music libraries
- **YouTube Music** contains only songs stored in Supabase.
- **Local Music** contains only audio imported/scanned into IndexedDB on that device.
- Search can still search both sources together.
- Local audio is never uploaded to Supabase.
