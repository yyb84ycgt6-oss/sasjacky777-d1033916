# Bonsai 1.7B — permanent guidance weights

The app carries its own guidance model. This folder is where it lives, so a
clone of this repo can answer questions about itself on a machine that has never
been online.

```
public/models/bonsai-1.7b/
├── Modelfile            # how Ollama builds the model from the weights here
├── README.md            # this file
└── bonsai-1.7b.gguf     # 248 MB, tracked with Git LFS
```

## Getting the weights

`bonsai-1.7b.gguf` is tracked with **Git LFS**, because GitHub rejects any single
file over 100 MB pushed as a normal blob. A clone without LFS gets a few hundred
byte pointer file instead of the model — the Guide panel detects exactly that and
says so rather than claiming the model is installed.

```sh
git lfs install          # once per machine
git lfs pull             # fetch the weights for this clone
```

To add or replace the weights:

```sh
git lfs install
git lfs track "public/models/**/*.gguf"        # already in .gitattributes
cp /path/to/bonsai-1.7b.gguf public/models/bonsai-1.7b/
git add .gitattributes public/models/bonsai-1.7b/bonsai-1.7b.gguf
git commit -m "Add Bonsai 1.7B guidance weights"
```

The file must be a GGUF build of Bonsai 1.7B of about 248 MB. The size the app
expects is declared once, in `src/lib/microai/models.ts`, and everything else —
the Model Bay budget, the station probe, the install command, the panel — reads
it from there.

## Installing it into Ollama

```sh
ollama create bonsai-1.7b -f public/models/bonsai-1.7b/Modelfile
```

No network is involved: `FROM` points at the file beside the Modelfile. Once
`ollama list` shows `bonsai-1.7b`, the Guide answers in sentences everywhere in
the app. Until then it still answers — from the route manifest, deterministically
— it just answers shorter.

## Why it is not precached by the service worker

`vite.config.ts` excludes `models/**` from the PWA precache. Workbox has a
per-file limit and a 248 MB entry fails the build outright, the same way the
embedded PC's on-device AI wasm does. The file is still served, and still
available offline once Ollama has built the model from it.
