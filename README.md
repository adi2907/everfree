# EverFree

I had to pay $100 for an Evernote renewal. For my notes. No way.

EverFree started as a script to get my notes out of Evernote, and grew into
the writing tool I actually wanted: an editor where an AI assistant sits next
to the draft — rewriting a paragraph, continuing where I stalled, checking a
claim — while the notes themselves stay plain Markdown files in a repo I own.
Think Cursor, but for writing.

It's free, MIT-licensed, and the Mac app ships as a signed and notarized DMG.

- Web app: [everfree.vercel.app](https://everfree.vercel.app)
- Mobile: [everfree.vercel.app/mobile](https://everfree.vercel.app/mobile/)
- Mac DMG: [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.0.1/EverFree.dmg)

## What it is

EverFree is a three-pane note editor with an AI assistant wired into it the
way Cursor is wired into code, on Cursor's own two keys. Select a passage
and press ⌘K, and the AI completes that block right there in the note — in
the same language and voice you were writing in (press ⌘K with nothing
selected and it continues from where you stopped; Esc cancels). Select a
passage and press ⌘L, and that exact excerpt becomes the context for a chat
message instead — ask it to rewrite the section, summarize the note, search
the web before answering, or generate an image with `/image`, then insert
the reply into the note with one click.

The same workspace is available on Mac, in the browser, and on mobile — all
three edit the same notes, synced through a private GitHub repository you
own. Under the hood everything is plain Markdown in ordinary folders, so if
this project disappeared tomorrow, your notes would still be sitting in your
repo as files you can open anywhere.

## Setting up the AI

The editor works without any AI configuration. When you want the assistant,
bring your own key: the desktop app supports LM Studio (fully local, no key
needed), OpenRouter, and Gemini; the web app supports OpenRouter and Gemini.
Web search needs a free [Serper](https://serper.dev) key. Keys are entered in
the assistant settings — in the web app they stay in your browser and are
sent only with the request being made.

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
sign in with GitHub (a one-time device code, no password), and pick a private
repository for your workspace. There is no EverFree account and no EverFree
database — the web editor commits directly to your repo through the GitHub
API.

## Contributing

Contributions are welcome. Development setup, pre-PR checks, and DMG build
instructions live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

EverFree stands on two excellent tools: `evernote-backup` for Evernote auth,
sync, and ENEX export, and `evernote2md` for converting ENEX to Markdown.
