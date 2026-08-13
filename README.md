# EverFree

EverFree started as a script to get my notes out of Evernote, and grew into
the writing tool I actually wanted: a focused editor where notes stay in Github in a repo I own

With an in-built AI assistant using free models like Gemini 3.5 (500 requests per day) to help me in my daily writing
The AI has a search and image generation feature as well, for which you will need paid licenses from Gemini or OpenRouter. Bring your own key

It is fully featured, syncs across devices and your backend stays the same. Your github repo.

I am a compulsive note taker. When Bending Spoons (the owner of Evernote) hiked my annual renewal to $100 for a tiny bit of cloud storage, I needed to get out.

My coding agents read and write these notes too. The Mac app ships an MCP server,
so Claude Code can look things up in my notes instead of asking me again.

It's free, MIT-licensed, and the Mac app ships as a signed and notarized DMG.

- Web app: [everfree.vercel.app](https://everfree.vercel.app)
- Mobile: [everfree.vercel.app/mobile](https://everfree.vercel.app/mobile/)
- Mac DMG: [EverFree.dmg](https://github.com/adi2907/everfree/releases/download/v1.6/EverFree.dmg)


## Getting started

**On the Mac:** download the
[DMG](https://github.com/adi2907/everfree/releases/download/v1.6/EverFree.dmg)
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

## Notes as memory for coding agents

I spend all day in Claude Code, and it kept forgetting things I had already
written down. So the Mac app now ships an MCP server. Your agent can search
your notes, read them, and write back what it decided.

With EverFree running:

```bash
claude mcp add everfree -- /Applications/EverFree.app/Contents/MacOS/everfree-mcp
```

It is my disk, not my second brain. EverFree keeps the Markdown and gets out of
the way. No summarising, no extracted "facts", no embeddings deciding what is
relevant. The agent works that out. Whatever it writes is a normal note, so it
shows up on my phone like anything else.

Mac only. The details are in [`docs/agent-access.md`](docs/agent-access.md).

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
