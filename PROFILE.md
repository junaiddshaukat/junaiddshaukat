# How this profile is built

`README.md` and the panels in `profile/generated/` are generated. Don't edit them by hand.

- **Words, projects, links:** edit `profile.config.json`. Placeholders like `{merged}`, `{npmTotal}`, `{npm:tkntracker}`, `{language}` and `{updated}` are filled from live data.
- **Generator:** `scripts/build-profile.mjs`, Node standard library only.
- **Images:** banners and logos live in `profile/assets/`. Project banners are either an image (`"type": "image"`) or drawn by the script (`code`, `icon`, `terminal`).
- **Fonts:** Geist Mono, Instrument Sans and Gochi Hand, embedded into each panel. All under the SIL Open Font License; see `fonts/OFL-*.txt`.
- **Updates:** `.github/workflows/refresh.yml` rebuilds everything daily and whenever the config changes. If an API call fails, the last good value in `profile/cache.json` is used.

Run it locally:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/build-profile.mjs
```
