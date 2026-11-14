# Apple Passwords for bb

Fill saved Apple Passwords (iCloud Keychain) into the bb desktop browser.
Touch ID confirms every password.

## Parts

| Part | Where it runs | What it does |
| --- | --- | --- |
| Plugin (`app.tsx`, `lib/`) | bb desktop app | Keys button in the bb browser toolbar, login picker under login fields, password search, setup page |
| Companion (`companion/`) | Your Mac, as a LaunchAgent | Local HTTP API on `127.0.0.1:47823`, Touch ID checks, bridge to Apple Passwords |
| Apple's iCloud Passwords extension | Headless Chrome, started by the companion | Talks to `PasswordManagerBrowserExtensionHelper`, the Apple helper in macOS |

Apple's password helper accepts only Apple's signed Chrome extension. The
companion therefore starts headless Chrome with its own profile, loads a copy
of Apple's extension, and calls the extension functions over the Chrome
DevTools Protocol on a private pipe. It opens no debugging port. Apple's
extension files are copied at run time from your Chrome profile and are not
part of this repository.

## Install

1. Install Google Chrome and the
   [iCloud Passwords extension](https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj).
2. Install the companion. Use Node 24 or later:

   ```sh
   node companion/cli.ts install
   ```

   The command compiles the Touch ID tool, writes
   `~/Library/Application Support/bb-apple-passwords/config.json`, and starts
   the LaunchAgent `app.getbb.apple-passwords-companion`. It allows the bb
   server addresses from the bb desktop app settings. To allow another bb
   address, add `--origin https://your-bb-server`.
3. Install the plugin in bb: `bb plugin install git:<repository URL>@main`.
4. In bb, open **Apple Passwords** in the sidebar:
   1. Click **Connect** and confirm with Touch ID.
   2. Click **Start pairing**. macOS shows a six-digit code.
   3. Type the code and click **Pair**.

## Use

1. Open a login page in the bb browser and click the user name or password
   field. Your saved logins for the site appear below the field. The keys
   button beside the address bar opens the same list.
2. Pick a login and confirm with Touch ID.
3. To use a login that is saved for another site, type its site in **Search
   by site** in the list, for example `github` or `mail.example.org`. The picker asks you to confirm before it fills a
   login on a site that is not the saved site.
4. If bb is not connected or Apple Passwords needs to pair again, the list
   shows a button. Click it. Touch ID connects bb. For pairing, macOS shows a
   six-digit code, and a small code box opens beside the keys icon in the
   browser toolbar. Type the code there. bb stays on the browser. The code box
   belongs to bb, not to the web page, so the page cannot read the code.
5. To copy a password, use **Search your passwords** on the **Apple
   Passwords** panel and click **Copy password**. Touch ID confirms it.

## Companion commands

| Command | Result |
| --- | --- |
| `node companion/cli.ts install` | Install or update, and start at login |
| `node companion/cli.ts status` | Show the companion state |
| `node companion/cli.ts uninstall` | Stop and remove the companion. The config file stays. |
| `node companion/cli.ts run` | Run in the foreground |

Install options: `--origin <url>` (more than one is allowed), `--port <number>`,
`--chrome <path>`, `--biometrics-only` (Touch ID only, no Mac password
fallback). The log is `~/Library/Logs/bb-apple-passwords.log`.

## Security

- The companion listens on `127.0.0.1` only. It rejects other `Host` headers
  and any `Origin` that is not on the allowlist.
- `POST /v1/connect` issues a token only after Touch ID. The companion stores
  only the SHA-256 hash of the token.
- `POST /v1/logins` and `POST /v1/search` return user names and sites only.
- `GET /v1/icon/<name>` serves only the four Apple toolbar images from the
  local extension copy. The repository does not contain Apple's images.
- `POST /v1/password` asks for Touch ID each time. The response is not cached.
- The picker is in a closed shadow root. It accepts only trusted user clicks
  and keys. Before it fills, it checks that the page is still on the same site.
- The picker opens by itself only on a trusted focus or click in a login
  field. It never fills without a pick. After you close it, it stays closed
  until you click a login field again or the page changes.
- A login that is saved for another site needs a second confirmation, and
  the Touch ID text names both sites.
- The companion never writes a password to disk or to the log.

## Limits

- Apple's extension keeps the pairing in memory. The pairing lasts while the
  companion runs. If the companion or its Chrome restarts, pair again.
- The picker fills the top document only. It does not fill logins inside
  frames.
- Search is by site, because Apple's helper looks up one site at a time. A
  word without a dot searches the word plus `.com`, for example `github`
  searches `github.com`. Apple's helper has no search of the whole store. An
  empty search makes the helper exit, so the companion never sends one.
- The token is in the bb app local storage. Other bb plugins in the same app
  can read it. Touch ID for each password limits what a stolen token can do.
- Apple's extension keeps the pairing key in memory only. If the companion,
  its Chrome, or the Mac restarts, pair again on the setup page.
- The companion must run on the Mac where you use the bb desktop app, and it
  must allow the bb address that this Mac uses. `node companion/cli.ts status`
  shows the allowed addresses.
- If Apple changes the internal functions of its extension, the bridge in
  `companion/bridge.ts` must change too.

## Tests

```sh
npm test
```

The tests cover the HTTP API with fakes, the Apple message parsing, and the
page script in real headless Chrome.
