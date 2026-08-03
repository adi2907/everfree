# EverFree

I had to pay $100 for an Evernote renewal. For my notes. No way.

EverFree started as a script to get my notes out of Evernote, and grew into
the writing tool I actually wanted: a focused editor where notes stay plain
Markdown files in a repository I own.

It's free, MIT-licensed, and the Mac app ships as a signed and notarized DMG.

- Web app: [everfree.vercel.app](https://everfree.vercel.app)
- Mobile: [everfree.vercel.app/mobile](https://everfree.vercel.app/mobile/)
- Mac DMG: [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)

## What it is

EverFree is a three-pane Markdown note editor. The same workspace is available
on Mac, in the browser, and on mobile — all
three edit the same notes, synced through a private GitHub repository you
own. Under the hood everything is plain Markdown in ordinary folders, so if
this project disappeared tomorrow, your notes would still be sitting in your
repo as files you can open anywhere.

## Assistant

Open a note and use the sparkle button to start a chat. The assistant receives
the current note, any text selected in the editor, the current conversation,
and your message as separate context. There are no slash commands: ask in
natural language, including when you want it to search the public web. It
cannot search your other notes.

The only chat actions are **New chat** and **Resume chat**. A Google Gemini API
key is required and is kept in the current browser tab; EverFree does not save
it on the server. Previous chats are saved locally in the browser so they can
be resumed from the same note.

## Getting started

**On the Mac:** download the
[DMG](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)
and open it — it's signed and notarized, so no Gatekeeper workarounds. The
setup wizard walks you through allowing Documents access, optionally
connecting Evernote to import your old notebooks as Markdown, and connecting
GitHub for sync. Notes live in `~/Documents/EverFree`. Evernote conversion
needs `evernote2md` (`brew install evernote2md`); the wizard can install it
for you if Homebrew is available.

**In the browser:** open [everfree.vercel.app](https://everfree.vercel.app),
sign in with GitHub (a one-time device code, no password), and connect your
private `everfree-notes` repository. EverFree creates that exact repository
when it is absent and never selects or
creates a differently named repository. There is no EverFree account and no
EverFree database — the web editor commits directly to your repo through the
GitHub API.

Maintainers configuring authentication should read
[`docs/github-oauth-setup.md`](docs/github-oauth-setup.md). The security and
cross-platform credential-storage decision is recorded in
[`docs/adr/0001-github-auth-and-credential-storage.md`](docs/adr/0001-github-auth-and-credential-storage.md).

## Contributing

Contributions are welcome. Development setup, pre-PR checks, and DMG build
instructions live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

EverFree stands on two excellent tools: `evernote-backup` for Evernote auth,
sync, and ENEX export, and `evernote2md` for converting ENEX to Markdown.
