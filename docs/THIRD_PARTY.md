# Third-party projects

`third_party/` holds other people's projects, each copied whole by
`scripts/vendor.sh` at the commit `third_party/UPSTREAM` pins and kept exactly
as upstream has it. Nothing in Jackie imports them; they sit beside the app,
not inside it. This page says what each one is, what it may be used for, and
what its security review found, because "it is in our repository" is easy to
mistake for "we checked it".

## The rules

- **Never edit a vendored file.** To move a project, run
  `scripts/vendor.sh <name> <commit>`; to prove nothing drifted, run
  `scripts/vendor.sh --check`. An untouched copy is the only kind anyone can
  audit by re-fetching, and for FilmCraft it is also a licence condition
  (below).
- **Their agent instructions are not ours.** FilmCraft's `CLAUDE.md` tells
  agents to start every session from FilmCraft's plan, pick their own tasks,
  commit after each one and not stop to ask. That is right for FilmCraft's
  contributors and wrong for anyone working on Jackie, so
  `.claude/settings.json` (`claudeMdExcludes`) keeps Claude Code from loading
  any `CLAUDE.md` or `AGENTS.md` under `third_party/`. Start sessions at the
  repository root: a session started inside `third_party/filmcraft/` may not
  read the root settings and would load it. `/context` lists the memory files
  a session actually loaded.
- **Their `.mcp.json` is inert here.** Claude Code reads project MCP servers
  only from the repository root.
- **Commit imports with `git add -f third_party`.** The root `.gitignore`
  ignores `dist` and `*.log` anywhere, and would otherwise drop an upstream
  file without a word.
- **No Git LFS, nothing over 100 MB.** `vendor.sh` refuses a project that
  keeps files in LFS (`git archive` would hand over pointers, and a pointer
  committed here makes every push demand an object this repository never had)
  or carries a file GitHub would reject.

`src/test/third-party.test.ts` checks what can be checked offline: every
folder is pinned, every pin is a full commit, every project kept its licence,
and craft-libs is the commit FilmCraft builds against.

## FilmCraft — `third_party/filmcraft`

The ArtCraft team's open-source, clean-room take on Adobe Premiere Pro, in
Rust: source and program monitors, a multi-track timeline with every trim,
Lumetri-style colour, keyframes, Premiere's 93 video effects and about 30
transitions, its own H.264, HEVC, ProRes and AAC codecs, and every action
exposed as a command an agent can drive. Native on macOS, Windows and Linux; in the browser through
WebAssembly. Upstream calls it young and moving fast, and it is: the review
below found real rough edges.

- **Upstream:** [storytold/filmcraft](https://github.com/storytold/filmcraft)
  at `ca36cf9` (11 October 2026). Many GitHub copies exist; one
  (`filmcraft-app/filmcraft`, "Download filmcraft…") has the shape of a
  malware lure. Only `storytold` is upstream.
- **Licence:** MIT OR Apache-2.0 for the code, with `NOTICE`, `ATTRIBUTION.md`
  and a `.attribution` file beside each asset. The fonts (Inter, JetBrains
  Mono, Noto Serif) are OFL-1.1 with their licence texts.
- **Except the ArtCraft logos.** `docs/brand/` holds trademarks under their own
  licence (`docs/brand/LICENSE-brand.txt`), not MIT/Apache. They may be used
  "as part of copies of this repository" and inside FilmCraft itself. Anyone
  who publishes a *modified* FilmCraft must remove them (`crates/ui-egui`
  compiles two of them into the app) and must not present it as ArtCraft's.
  That is why the copy here is never edited. Never use the ArtCraft name or
  marks for anything of Jackie's.
- **craft-libs — `third_party/craft-libs`:** FilmCraft's one dependency outside
  crates.io (shared UI components), at the commit FilmCraft's `Cargo.toml` pins
  (`5c874d5`), same licence. FilmCraft fetches that commit from GitHub when it
  builds; the hash fixes the content. To build from the copy here instead,
  run cargo with a patch from inside `third_party/filmcraft`:

  ```bash
  cargo build --release -p filmcraft \
    --config 'patch."https://github.com/storytold/craft-libs".craft-ui.path="../craft-libs/crates/ui"'
  git checkout -- Cargo.lock   # the patch rewrites one lockfile line; keep the copy pristine
  ```

### Building and running it

Rust 1.95 or newer. `cargo run --release -p filmcraft` for the desktop app,
`-p filmcraft-cli` for the command line. The web build needs the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129 (see its
`docs/web.md`). It has **not** been compiled or run in this repository: the
session that imported it was not allowed to execute outside code, so
everything below comes from reading it.

### What the security review found

A static review read every file of both projects — build scripts, `xtask`,
packaging, CI, agent instructions, network, process and filesystem code, the
remote-control surface, model downloads and every binary file — and matched
all 652 crates.io dependencies against their published checksums.

**Nothing malicious.** No obfuscated payloads, no exfiltration, no hidden
network calls, no embedded executables, no Trojan Source characters, no
committed secrets. The three build scripts only generate code from local
files. All `unsafe` is confined to `crates/platform`. The network is touched
only by an opt-in model downloader that checks a SHA-256 for every file.

**Before you run it**, know these. All are upstream's design, documented or
not, and none is reachable from Jackie:

- **The control port (`--control <port>` or `FILMCRAFT_CONTROL_PORT`) has no
  authentication.** It listens on 127.0.0.1, which keeps browsers out but lets
  any other local process or user drive the editor with your rights: write a
  file anywhere (a caption export), overwrite one (a screenshot), delete media
  files, list folders, launch a path with the system opener. Its own docs say
  to enable it only while you use it. Never set the variable globally.
- **The MCP server (`filmcraft-cli mcp`) has no folder confinement.** Over
  stdio it is not network-reachable, but an agent given it can read, write and
  delete wherever you can, and it reads clip names, markers and captions from
  the open project verbatim — text a downloaded project could use to steer the
  agent. Do not wire it into Jackie's harnesses without a confinement layer.
- **Media Cache "Delete…" and its age policy delete every file under the
  chosen folder,** recursively, the policy at every start. Give it an empty
  folder of its own, never a drive or `~/Videos`.
- **Treat a downloaded `.fcproj` as untrusted.** It can name media on a
  network share (on Windows, opening it sends your NTLM hash), point scratch
  disks at any folder, and make Edit Original launch a path it supplies.
- **`cargo xtask web --serve` is a development server with a path traversal**
  (`GET /..../etc/passwd` escapes the dist folder) and no Host check. Serve
  `target/web/dist` with another server if you need one.
- **Downloads the GUI confirms, the control port and MCP do not:**
  `transcript.downloadModel` (up to 967 MB) and `tts.downloadVoices` (about
  336 MB) run without a prompt from those two surfaces. The downloader uses a
  pre-release TLS provider (`rustls-rustcrypto` 0.0.2-alpha) and has no read
  timeout.
- **Release packaging is upstream's, identity and all.** An AppImage built
  outside upstream's CI points its self-update at `storytold/filmcraft`
  releases; `packaging/linux/package.sh` runs `appimagetool` from a moving
  "continuous" tag unverified; the release workflow hands signing secrets to a
  reusable workflow pinned to `@main`. Its `.github/` workflows never run here
  (GitHub reads only the root `.github/`), but do not ship builds from these
  scripts unchanged.
- **One test downloads AV1 vectors with `curl`, unpinned and unchecked,** in
  the default `cargo test` run.
- **A dependency's build script (`rmcp` 3.5.0) sets `core.hooksPath` on the git
  repository two levels above its own source** — harmless while cargo keeps
  sources in `~/.cargo/registry`, but never `cargo vendor` FilmCraft's
  dependencies into this repository.
- `crates/h264enc/target/` is committed upstream despite its name: 3 MB of
  generated H.264 test output, inert.
