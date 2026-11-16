Fill your saved Apple Passwords into the bb browser. Touch ID confirms every
password before it leaves your Mac.

## What you get

- Click a login field in the bb browser and your saved logins for that site
  appear below it, as in Chrome. The Apple Passwords keys button beside the
  address bar opens the same list.
- Search your passwords by site from the list or from the setup page.
- Pick a login, confirm with Touch ID, and bb fills the user name and the
  password into the page.
- An **Apple Passwords** setup section in bb Settings. It shows the
  companion state and walks you through pairing.

## How it works

A small companion runs on your Mac. It uses Apple's own iCloud Passwords
extension and the password helper that is part of macOS. It does not copy
your keychain and it does not store passwords. It asks Apple Passwords for one
password at a time, only after Touch ID.

The companion listens only on `127.0.0.1`. It accepts requests only from your
bb server address and only with a token that you approve with Touch ID.

## Requirements

- macOS 14 or later, with iCloud Keychain turned on.
- Google Chrome, with the iCloud Passwords extension installed from the Chrome
  Web Store.
- Node 24 or later.
- The bb desktop app. The bb browser in a web browser cannot fill passwords.
