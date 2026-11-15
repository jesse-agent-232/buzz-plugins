// Voice Input: a Dictate button in the composer, after Voice Notes' mic. It
// records the way Voice Notes does, then whisper.cpp turns the speech into
// text on this Mac and the text goes in at the caret. Nothing is sent.
//
// whisper-cli runs from the manifest's one `processes` entry, under macOS
// `sandbox-exec` from `(deny default)`: its own programs, the system and
// Homebrew libraries, and the model, with no network, no system services and
// no other files (README.md, "What it can reach"). Process stdin is
// text, so the recording goes in as base64 and `base64 -D` decodes it inside
// the sandbox.

export const inject = ["conversation", "host", "react"];

// Voice Notes stops at five minutes too.
const MAX_SECONDS = 5 * 60;
// whisper.cpp works at 16 kHz mono.
const SAMPLE_RATE = 16_000;
const LEVEL_MS = 120;
// Enough 5 px bars for a wide composer; the strip clips the oldest.
const BARS = 256;
// Levels below this draw as flat dots, as in Voice Notes.
const QUIET = 0.16;
const TRANSCRIBE_MS = 2 * 60 * 1000;
// The process's exit codes when its model or whisper-cli is missing.
const NO_MODEL = 3;
const NO_WHISPER = 4;
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin";
// mp4 first: Buzz on macOS runs in WebKit, which records and decodes it natively.
const MIME_TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

const ERRORS = {
  denied: { text: "Allow Buzz to access your microphone to dictate." },
  unavailable: { text: "Dictation is not available in this environment." },
  noWhisper: { text: "Dictation needs whisper.cpp on this Mac. Install it with", code: "brew install whisper-cpp", after: ", then try again." },
  noModel: {
    text: "Dictation needs the base.en model. Download it with",
    code: `curl -L --create-dirs -o ~/.local/share/whisper/ggml-base.en.bin ${MODEL_URL}`,
    after: ", then try again.",
  },
  silent: { text: "No speech was heard. Close and try again." },
  failed: { text: "Buzz could not turn this into text. Close and try again." },
};

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// One 16-bit PCM WAV channel at SAMPLE_RATE: the channels averaged, then
// resampled by linear interpolation.
function encodeWav(channels, inputRate) {
  const length = channels[0]?.length ?? 0;
  const frames = Math.max(1, Math.floor((length * SAMPLE_RATE) / inputRate));
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  const ratio = inputRate / SAMPLE_RATE;
  for (let frame = 0; frame < frames; frame += 1) {
    const position = frame * ratio;
    const left = Math.min(length - 1, Math.floor(position));
    const right = Math.min(length - 1, left + 1);
    let sample = 0;
    for (const channel of channels) sample += channel[left] + (channel[right] - channel[left]) * (position - left);
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(44 + frame * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function base64(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

// whisper-cli prints one segment per line. Bracketed lines such as
// [BLANK_AUDIO] or (wind blowing) describe sound, not speech.
function transcriptText(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[[(].*[\])]$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// A "failed" error carrying the step that failed, shown after its text.
function failure(detail) {
  return Object.assign(new Error("failed"), { detail });
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;

  function icon(paths, props) {
    return h(
      "svg",
      { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props },
      ...paths.map((d) => h("path", { key: d, d })),
    );
  }
  // Tabler text-caption.
  const DICTATE = ["M4 15h16", "M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4", "M4 20h12"];
  const X = ["M18 6l-12 12", "M6 6l12 12"];

  // Buzz's icon button markup, so the app's styles apply.
  const IconButton = React.forwardRef(function IconButton({ label, variant = "ghost", children, ...props }, ref) {
    return h(
      "button",
      {
        ref,
        type: "button",
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant,
        "data-size": "sm",
        "data-icon-variant": variant,
        "data-icon-size": "sm",
        "data-icon-shape": "control",
        "aria-label": label,
        title: label,
        ...props,
      },
      h("span", { className: "buzz-button-label" }, children),
    );
  });

  // Records until stopped, or until MAX_SECONDS. Returns the recording as WAV.
  function useRecorder() {
    const session = React.useRef(null);
    const [status, setStatus] = React.useState("requesting");
    const [elapsed, setElapsed] = React.useState(0);
    const [levels, setLevels] = React.useState([]);

    const release = React.useCallback(() => {
      const current = session.current;
      session.current = null;
      if (!current) return;
      current.cancelled = true;
      if (current.recorder?.state === "recording") current.recorder.stop();
      current.stream?.getTracks().forEach((track) => track.stop());
      clearInterval(current.timer);
      void current.context?.close().catch(() => undefined);
    }, []);

    const start = React.useCallback(async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("unavailable");
      const current = { cancelled: false, chunks: [] };
      session.current = current;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, autoGainControl: true, echoCancellation: true, noiseSuppression: true },
        });
      } catch (cause) {
        const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
        throw new Error(denied ? "denied" : "unavailable");
      }
      current.stream = stream;
      if (current.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      current.recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      current.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) current.chunks.push(event.data);
      });
      current.context = new AudioContext();
      const analyser = current.context.createAnalyser();
      analyser.fftSize = 512;
      current.context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      current.timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5.5);
        setLevels((previous) => [...previous.slice(1 - BARS), level]);
        setElapsed((performance.now() - startedAt) / 1000);
      }, LEVEL_MS);
      current.recorder.start(250);
      setStatus("recording");
    }, []);

    const stop = React.useCallback(async () => {
      const current = session.current;
      const recorder = current?.recorder;
      if (!recorder || recorder.state !== "recording") return null;
      clearInterval(current.timer);
      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      recorder.stop();
      current.stream.getTracks().forEach((track) => track.stop());
      await stopped;
      const blob = new Blob(current.chunks, { type: recorder.mimeType || "audio/webm" });
      let decoded;
      try {
        decoded = await current.context.decodeAudioData(await blob.arrayBuffer());
      } catch (cause) {
        throw failure(`decode: ${cause?.name || "Error"}`);
      }
      const limit = Math.floor(decoded.sampleRate * MAX_SECONDS);
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).subarray(0, limit));
      release();
      return encodeWav(channels, decoded.sampleRate);
    }, [release]);

    React.useEffect(() => release, [release]);
    return { status, setStatus, elapsed, levels, start, stop, release };
  }

  // Runs whisper-cli on the recording. Resolves the text, or throws one of
  // the ERRORS keys.
  async function transcribe(wav, running) {
    let stdout = "";
    let stderr = "";
    const child = ctx.host.spawn("whisper", {
      cwd: "/tmp",
      onStdout: (data) => (stdout += data),
      onStderr: (data) => (stderr = (stderr + data).slice(-2000)),
    });
    running.current = child;
    const timeout = setTimeout(() => void child.kill(), TRANSCRIBE_MS);
    try {
      await child.end(base64(wav));
      const code = await child.exited;
      if (code === NO_MODEL) throw new Error("noModel");
      if (code === NO_WHISPER) throw new Error("noWhisper");
      if (code !== 0) {
        console.warn("voice-input: whisper-cli exited", code, stderr);
        const last = stderr.trim().split("\n").pop().slice(0, 160);
        throw failure(last ? `whisper-cli exit ${code}: ${last}` : `whisper-cli exit ${code}`);
      }
      const text = transcriptText(stdout);
      if (!text) throw new Error("silent");
      return text;
    } finally {
      clearTimeout(timeout);
      running.current = null;
    }
  }

  // Voice Notes' strip: the newest level on the right, flat dots before the
  // first sound and while waiting or transcribing.
  function Waveform({ levels }) {
    return h(
      "div",
      { className: "vi-waveform", "aria-hidden": true },
      h(
        "div",
        { className: "vi-strip" },
        Array.from({ length: BARS }, (_, slot) => {
          const level = levels[levels.length - BARS + slot] ?? 0;
          return h("span", { key: slot, className: "vi-bar", style: { height: 3 + Math.round(Math.max(0, (level - QUIET) / (1 - QUIET)) * 17) } });
        }),
      ),
    );
  }

  function DictateCapture({ cancel, insertText, focus }) {
    const recorder = useRecorder();
    const [error, setError] = React.useState(null);
    const [detail, setDetail] = React.useState(null);
    const running = React.useRef(null);
    const finishing = React.useRef(false);
    // False once discarded or closed by the host, so nothing later starts.
    const live = React.useRef(true);
    const discard = React.useRef(null);
    const stopButton = React.useRef(null);
    const close = React.useRef(null);
    const { status, elapsed } = recorder;

    React.useEffect(() => {
      // Strict Mode can dispose a mount at once; ask for the mic only once.
      let current = true;
      queueMicrotask(() => {
        if (current) recorder.start().catch((cause) => setError(ERRORS[cause.message] ? cause.message : "unavailable"));
      });
      return () => {
        current = false;
        void running.current?.kill();
      };
    }, []);
    React.useEffect(() => {
      live.current = true;
      return () => {
        live.current = false;
      };
    }, []);
    React.useLayoutEffect(() => {
      if (error) close.current?.focus();
      else if (status === "recording") stopButton.current?.focus();
      else discard.current?.focus();
    }, [error, status]);

    async function finish() {
      if (finishing.current) return;
      finishing.current = true;
      recorder.setStatus("transcribing");
      try {
        const wav = await recorder.stop();
        if (!live.current) return;
        if (!wav) throw failure("recording stopped early");
        const text = await transcribe(wav, running);
        if (!live.current) return;
        cancel();
        insertText(text);
        focus();
      } catch (cause) {
        if (!live.current) return;
        setDetail(cause.detail ?? null);
        setError(ERRORS[cause.message] ? cause.message : "failed");
      }
    }
    React.useEffect(() => {
      if (status === "recording" && elapsed >= MAX_SECONDS) void finish();
    });
    function discardAll() {
      live.current = false;
      void running.current?.kill();
      recorder.release();
      cancel();
      focus();
    }

    if (error) {
      const message = ERRORS[error];
      return h(
        "div",
        { className: "vi-capture" },
        h("style", null, CSS),
        h(
          "span",
          { role: "alert", className: "vi-error" },
          message.text,
          message.code && [" ", h("code", { key: "code", className: "vi-code" }, message.code), message.after],
          detail && ` (${detail})`,
        ),
        h(
          "button",
          { ref: close, type: "button", "data-buzz-ui": "", className: "buzz-button", "data-variant": "subtle", "data-size": "sm", onClick: discardAll },
          h("span", { className: "buzz-button-label" }, "Close"),
        ),
      );
    }
    const caption =
      status === "requesting"
        ? h("span", { className: "vi-caption", role: "status" }, "Waiting for microphone…")
        : status === "transcribing"
          ? h("span", { className: "vi-caption", role: "status" }, h("span", { className: "vi-spinner", "aria-hidden": true }), "Turning speech into text…")
          : h(
              "span",
              { className: "vi-caption", role: "status" },
              "Dictating ",
              formatTime(Math.min(elapsed, MAX_SECONDS)),
              h("span", { className: "vi-muted" }, ` / ${formatTime(MAX_SECONDS)}`),
            );
    return h(
      "fieldset",
      { className: "vi-capture" },
      h("style", null, CSS),
      h("legend", { className: "sr-only" }, "Dictation"),
      h(IconButton, { ref: discard, label: "Discard dictation", variant: "subtle", onClick: discardAll }, icon(X)),
      caption,
      h(Waveform, { levels: status === "recording" ? recorder.levels : [] }),
      h(
        IconButton,
        { ref: stopButton, label: "Stop dictating", variant: "subtle", disabled: status !== "recording", onClick: () => void finish() },
        h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true }, h("rect", { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: "currentColor" })),
      ),
    );
  }

  ctx.conversation.registerTool({
    id: "dictate",
    title: "Voice Input",
    // After Voice Notes' mic (10).
    order: 11,
    component: ({ disabled, capture, insertText, focus }) =>
      capture && typeof ctx.host.spawn === "function"
        ? h(
            React.Fragment,
            null,
            h("style", null, CSS),
            h(
              IconButton,
              {
                label: "Dictate",
                disabled,
                onClick: () => capture(({ cancel }) => h(DictateCapture, { cancel, insertText, focus })),
              },
              icon(DICTATE),
            ),
          )
        : null,
  });
}

// Voice Notes' capture strip, with the host's tokens.
const CSS = `
.vi-capture {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: var(--size-control-sm);
  gap: var(--space-1);
  border: 0;
  padding: 0;
  margin: 0;
}
.vi-caption {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-caption);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--text-standard);
}
.vi-muted {
  color: var(--text-subtle);
}
.vi-waveform {
  display: flex;
  justify-content: flex-end;
  flex: 1;
  height: 24px;
  min-width: 0;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent);
}
.vi-strip {
  display: flex;
  align-items: center;
  gap: var(--space-half);
  height: 100%;
}
.vi-bar {
  display: block;
  width: 3px;
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  background: var(--text-standard);
}
.vi-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--text-subtle);
  border-top-color: transparent;
  border-radius: 50%;
  animation: vi-spin 800ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .vi-spinner {
    animation-duration: 2400ms;
  }
}
@keyframes vi-spin {
  to {
    transform: rotate(360deg);
  }
}
.vi-error {
  flex: 1;
  min-width: 0;
  font-size: var(--text-caption);
  color: var(--text-danger);
}
.vi-code {
  font-family: var(--font-mono, ui-monospace, monospace);
  user-select: all;
  overflow-wrap: anywhere;
}
`;
