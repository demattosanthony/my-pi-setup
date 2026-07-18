# Setup

## Install

Prerequisites: Pi, cmux, Bun 1.3.14 or newer, Node.js, and Git. Node remains required for the permission-restricted workflow sandbox. Claude Code and Codex are optional subagent backends.

Local call transcription also requires:

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Library/Caches/whisper.cpp
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
  -o ~/Library/Caches/whisper.cpp/ggml-large-v3-turbo-q5_0.bin
```

```sh
mkdir -p ~/projects
git clone https://github.com/demattosanthony/my-pi-setup.git ~/projects/my-pi-setup
cd ~/projects/my-pi-setup
bun install --frozen-lockfile
bun run apply
```

Install cmux's native Pi hook so `/diff last` can snapshot each agent turn:

```sh
cmux hooks pi install --yes
```

Start Pi, use `/login` to authenticate providers, then run `/reload`. Credentials and runtime state are not stored in this repository.

Pi loads this checkout directly as a local package. There is no build or copy step.

## Apply configuration

Preview changes:

```sh
bun run apply --dry-run
```

Apply changes:

```sh
bun run apply
```

The apply script:

- Merges `config/settings.json` into `~/.pi/agent/settings.json`.
- Registers the current checkout as the first local Pi package.
- Merges stable Better OpenAI preferences without resetting runtime state.
- Backs up changed files under `~/.pi/backups/apply-*`.
- Writes changes atomically.

It does not modify credentials, sessions, trust decisions, secrets, package caches, or workflow artifacts. It installs the version-controlled `transcribe-audio` helper into `~/.local/bin`.

## Call notes

Run the interactive workflow to choose a recent recording from `~/Downloads`:

```text
/call-notes
```

Use the most recent recording immediately, or provide explicit input and output paths:

```text
/call-notes latest
/call-notes ~/Downloads/customer-call.m4a docs/recordings
```

When the current project has `docs/recordings`, the default output is a dated folder there. The workflow copies the recording and creates TXT, SRT, and concise Markdown summary files. Whisper transcription stays local; summary generation sends the timestamped transcript to the active Pi model provider after showing a confirmation.

Run `transcribe-audio --help` to use local transcription without Pi. The apply script installs it in `~/.local/bin`; ensure that directory is on `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Development

Pi reads extensions, skills, and themes directly from this checkout:

```text
edit -> validate -> /reload
```

Validate changes with:

```sh
bun run format:check
bun run check
bun test
```

Run `bun install --frozen-lockfile` after pulling dependency changes. Restart Pi after dependency or startup-setting changes.

## Safety

Subagents and pull-request workflows can run commands or modify repositories with your user permissions. The workflow sandbox restricts orchestration code, but child agents can still modify the current project. Review changes before committing.

## Rollback

Apply backups are stored under:

```text
~/.pi/backups/
```

To stop loading this checkout, remove its path from the `packages` array in `~/.pi/agent/settings.json`, then restart Pi.
