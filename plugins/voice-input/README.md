# Voice Input

Dictate into the Buzz composer. Choose **Dictate** (after the Voice note mic),
talk, then choose **Stop**. [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
turns your speech into text on this Mac, and the text goes into the composer
at the caret for you to check. Nothing is sent until you send it.

- English only, with the `base.en` model (`small.en` if that is the one you have).
- A recording stops at 5:00, the same as a voice note.
- **X** discards the recording, or stops transcribing it.

## Getting started

1. Install whisper.cpp:

   ```sh
   brew install whisper-cpp
   ```

2. Download the model to the one place the plugin reads it from, then check it:

   ```sh
   curl -L --create-dirs -o ~/.local/share/whisper/ggml-base.en.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin
   shasum -a 256 ~/.local/share/whisper/ggml-base.en.bin
   # a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
   ```

   If `base.en` gets too many words wrong, use `small.en` instead (465 MB,
   slower). Remove `ggml-base.en.bin`, because the plugin prefers it:

   ```sh
   curl -L -o ~/.local/share/whisper/ggml-small.en.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en.bin
   shasum -a 256 ~/.local/share/whisper/ggml-small.en.bin
   # c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d
   ```

3. Install the plugin (below), then choose **Dictate** in any composer. The
   first time, macOS asks to let Buzz use the microphone.

The plugin downloads nothing itself. If whisper.cpp or the model is missing,
the composer says so and shows the command for it.

---

## Install

In Buzz: **Settings → Plugins → Manage plugins → Add**, then **Browse** under
Add from folder, and pick this repository's `plugins/voice-input/` folder.
Review the access it asks for (one process, below) and install it.

## What it can reach

The manifest declares one process and nothing else: no network origins, no
commands, no file access. That process is macOS `sandbox-exec` with a fixed
profile, running a fixed `/bin/sh` line. The plugin passes it no arguments, so
what you review at install is all it runs.

Inside the sandbox, whisper-cli:

- **has no network**, in or out, and opens no port;
- **can run only** `sh`, `base64` and programs under `/opt/homebrew` or
  `/usr/local` (where Homebrew puts whisper-cli);
- **reads nothing under `/Users` or `/Volumes`** except
  `~/.local/share/whisper/ggml-base.en.bin` or `ggml-small.en.bin`;
- **writes nothing** except `/dev/null` and the system's per-user temp and
  cache folder (`/private/var/folders`), which Metal uses for its GPU caches.

The recording reaches it on stdin as base64 (plugin processes take text), and
`base64 -D` decodes it inside the sandbox. The text comes back on stdout.

### A second layer: LuLu

With [LuLu](https://objective-see.org/products/lulu.html), add a rule for
`/opt/homebrew/bin/whisper-cli` (or the path `which whisper-cli` prints) that
**blocks** all outbound connections. Dictation keeps working, since whisper-cli
never needs the network after the model is on disk.

## When it does not work

The composer shows one of these:

| It says | What to do |
|---|---|
| Allow Buzz to access your microphone | System Settings → Privacy & Security → Microphone, turn on Buzz |
| Dictation needs whisper.cpp | `brew install whisper-cpp` |
| Dictation needs the base.en model | Step 2 above |
| No speech was heard | Try again, closer to the mic |
| Buzz could not turn this into text | Run the same thing in Terminal, below |

The last one usually means the sandbox blocked something whisper-cli needed.
To see what, run the process by hand on a WAV file, then look for `deny` lines
in the sandbox log:

```sh
base64 -i some.wav | sandbox-exec -p "$(jq -r '.host.processes[0].args[1]' manifest.json)" \
  /bin/sh -c "$(jq -r '.host.processes[0].args[4]' manifest.json)"
log show --last 2m --predicate 'sender == "Sandbox"' | grep whisper
```

## Limits

- macOS only (`sandbox-exec` and Homebrew).
- English only.
- The text goes in exactly as whisper.cpp wrote it. Check it before you send.
