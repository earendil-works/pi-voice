# Pi Voice

Local speech-to-text for Pi.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

## Install

Install the npm package:

```bash
pi install npm:@earendil-works/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/voice`, which does the same as the shortcut. While recording, `Space` also stops and transcribes, and `Escape` discards;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

## Upgrading from pi-transcribe

It's recommended to install Pi Voice via NPM. If you have an older install of pi-transcribe uninstall it via: 

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with:

```bash
pi install npm:@earendil-works/pi-voice
```

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 512 MiB (about 2.3 hours). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in the interactive TUI to choose and, after confirmation, download a local model.

### Keeping `transcribe_file` out of the context

To keep `transcribe_file` out of the model's tool list and the `codemode` description while leaving it discoverable and callable, set `transcribeFileExposure` in `~/.pi/agent/pi-voice.json` from `"direct"` to `"deferred"` once `/voice-settings` has run (add the key if the file predates it):

```json
"transcribeFileExposure": "deferred"
```

Applies on the next start or `/reload`. Scripts find it with `searchTools()` when `codemode` is enabled (`"defaultTools": ["+codemode"]`), and `tool_search` can load it if enabled. Requires Pi 0.99.2 or later; older Pi ignores it. Resuming a session started before the change keeps the tool declared in that session.

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:earendil-works/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```
