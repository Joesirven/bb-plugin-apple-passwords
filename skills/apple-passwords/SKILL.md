---
name: apple-passwords
description: Use when a user asks about filling Apple Passwords or iCloud Keychain logins in the bb browser, or when the Apple Passwords plugin or its companion does not work.
---

# Apple Passwords plugin

The plugin fills Apple Passwords into the bb desktop browser. A person must
confirm each password with Touch ID. An agent cannot get a password through
this plugin, and must not try.

## Parts

- The plugin offers logins when a login field gets focus in the bb browser,
  adds a keys button to the bb browser toolbar, and adds an
  **Apple Passwords** setup page in the sidebar.
- The companion runs on the Mac at `http://127.0.0.1:47823`.

## Check the state

1. Run `node companion/cli.ts status` in the plugin folder on the Mac.
2. Read the result:
   - "The companion is not running": run `node companion/cli.ts install`.
   - `pairing: "unpaired"`: tell the user to open the setup page and pair.
   - `pairing: "unavailable"`: read `detail`. Usually Chrome or the iCloud
     Passwords extension is missing, or iCloud Keychain is off.
3. Read the log at `~/Library/Logs/bb-apple-passwords.log`.

## Rules

- Never read, print, or store a password value.
- Never type the pairing code for the user. Never read it from the screen.
- Never automate Touch ID.
- If the bb server address changes, run
  `node companion/cli.ts install --origin <new address>`.
