# Codex agent prompt — build a production-grade automatic audio fixer

You are a senior audio-DSP engineer and full-stack TypeScript developer. Build a genuinely useful, production-quality, privacy-preserving **automatic audio repair web application** for long lecture/classroom recordings. The provided **ClearLecture** folder is your starter repository. Inspect and test its current code first; preserve what works, replace weak areas, and fix bugs rather than merely reskinning the UI. If you do not have the repository, create the project from scratch with the same goals.

## The actual problem

A student has 30–120-minute recordings of an instructor in a classroom, typically 40–150 MB AAC in `.m4a`, sometimes WAV/MP3/Opus. Common flaws are continuous hiss/HVAC noise, low-frequency thumps/handling, pen/paper scratches, chair movement, distinct clicks, reverberation, distant or quiet speech, loudness jumps, clipping and occasional overlapping voices. **The instructor must remain natural, intelligible and audible.** Do not over-suppress consonants, erase quiet speech, or cut/shorten meaningful lecture content. Be transparent that a sound directly overlapping speech may be impossible to remove fully.

## Hard constraints

1. **Privacy & hosting:** Default processing must be 100% client-side, offline-capable after first load, with **no audio upload**. Deployable as a static application on **Cloudflare Pages free tier** or equivalent. Do not put audio DSP on Cloudflare Workers. No loggers or telemetry that leak audio or filenames. A server may only be an optional, explicitly opt-in extension and must not be required.
2. **Real long-file support:** A 90-minute 48 kHz mono M4A file must process without decoding the entire lecture into a giant `AudioBuffer` or retaining the whole decoded stream in memory. Use progressive MP4 demuxing + WebCodecs decoding where supported; a Web Worker for DSP; and robust backpressure from output writes. Budget memory, use streaming wherever possible, and include graceful unsupported-browser behavior. Protect against 4 GB WAV limits and insufficient disk space.
3. **Formats:** Support normal AAC-LC M4A/MP4 and PCM WAV well; add MP3 and Opus/WebM input if practical, with clearly documented fallbacks. Export reliable WAV PCM16/PCM24, plus a smaller compressed format **only if** encoding support exists; prefer WebCodecs/Opus with a valid muxer or a packaged local WASM encoder. Never claim M4A output unless it truly works.
4. **No false claims:** Do not claim neural source separation, “perfect noise removal,” forced speech recognition, or measured quality improvements without running relevant tests. Preserve original duration and audio continuity except user-selected trimming.

## Functional goals

- Polished, responsive, accessible interface: drag/drop, original and cleaned preview with an A/B switch, waveform or spectrogram preview for a sample window, progress + cancel + error recovery, file metadata, automatic improvement recommendations, clean download, presets Gentle/Balanced/Strong, and advanced controls. Support keyboard interaction, screen readers and small screens.
- **Analyze audio first** using representative slices from the beginning, middle, and end. Estimate noise floor, stationary/nonstationary noise, hum frequency, impulsive events, clipping, peak and RMS, silence, and speech activity where practical. Display an honest before/after quality report, including sample-rate/codec, true peak estimates, estimated noise floor and resulting loudness. Explain limitations of each metric.
- **Automatic repair pipeline** with independently switchable modules: (a) DC offset + controlled high-pass for rumble; (b) mains hum/notch if detected; (c) pop, click and transient reduction while preserving plosive consonants; (d) adaptive stationary noise suppression (Wiener/spectral gate/noise profiling or local RNNoise), robust smoothing to prevent musical noise; (e) optional de-reverb only when defensible; (f) speech-aware loudness leveling with attack/release and silence-safe limits; (g) gentle dynamics / true-peak limiting; (h) optional low-pass/anti-alias resampling. Prefer voice intelligibility to aggressively quiet output.
- Detect problematic cases automatically and choose conservative defaults, but let users override decisions. Preserve all speech; if a segment's confidence is low, reduce treatment rather than silencing it.
- Include a local command-line **FFmpeg batch-processing alternative** for users who need compressed AAC output or jobs beyond browser limits; clearly distinguish its filters/output from the browser implementation. Keep this optional, not a required backend.

## Engineering requirements

- Modular, well-commented TypeScript or modern JavaScript with a documented DSP chain and testable pure functions. Avoid a massive all-in-one component. Streaming Worker concurrency, explicit writer acknowledgements and bounded queues; release `AudioData`, MP4 sample buffers and object URLs. Do not load the full audio file just to get the `moov` atom. Handle typical AAC sample tables, encoder delay/edit lists, timestamps, missing/corrupt samples, stereo-to-mono choices, file cancellation and limits gracefully.
- Browser support: feature-detect WebCodecs, File System Access API and WASM/Web Workers. Direct-to-file export on supported browsers; use OPFS or another safe streaming alternative where possible. Warn before memory-heavy Blob exports; do not silently crash on long files.
- Provide safe default settings and stable output sampling; no unexpected pitch changes, clipped output, large phase artifacts, long zero padding or incorrect duration. A/B playback must time-align (allow for encoder delay).
- Supply `README.md` with local setup, Cloudflare Pages step-by-step deployment, supported formats, privacy statement, architecture, DSP limitations, quality guidance and troubleshooting. Include optional license/attribution for any third-party packages or pretrained models.

## Automated verification and acceptance criteria

- Unit tests for FFT, perfect/near-perfect reconstruction with denoising disabled, STFT overlap-add correctness, streaming chunk-boundary invariance, WAV/MP4 parsers, click detector, AGC/limiter bounds, silence/NaN behavior, short odd-length clips, resampling and exact PCM output length.
- Integration tests with **synthetic** audio (speech-like harmonic signals + white/pink noise, intermittent hum, pen-like clicks, volume dips, clipping). Include deterministic test generators; do not commit private classroom recordings.
- Browser end-to-end tests in Playwright/Chromium that upload a fixture M4A, process, save, reopen the WAV, verify successful decode, realistic duration, non-silent signal, no severe clipping, and cancellation/retry. Document which environments and browsers were actually tested.
- Optional objective evaluation scripts comparing test-set input/output SNR for known synthetic mixtures, speech distortion metrics and loudness/peak changes. Never interpret simple noise reduction alone as guaranteed intelligibility gain; perform human A/B listening checks.
- A clear performance benchmark and bounded-memory target on representative 60–90-minute inputs; report measured times/memory on an actual device instead of inventing figures.
- `npm run dev`, `npm run test`, `npm run build`, and a reproducible static deployment. If choosing a zero-dependency app without build, offer equivalent instructions and automate verification.

## Working style and deliverables

1. Audit the existing files and enumerate concrete bugs, risks, unsupported cases and quality gaps. Make prioritized changes directly in the project; **do not stop at a plan or pseudocode**.
2. Implement a complete working product end-to-end, with small reviewable modules and runnable tests. Preserve privacy, the existing useful UI, and a no-backend path.
3. Run tests, build, and browser integration tests where available; fix issues until passing. For features you cannot verify, clearly mark them unverified with exact reproduction steps.
4. Deliver full source, a deployment-ready static `dist/` or equivalent, any model assets required for offline use (subject to license), and a ZIP of the full project. Provide run/deploy instructions and a concise change log.
5. Never ask me to choose trivial technical defaults—use sensible voice-first defaults. Ask only if a decision truly blocks implementation. Focus on natural, understandable teacher speech, not just low measured noise.

**Definition of success:** I can open a Cloudflare Pages URL on my laptop, select a 60–90-minute classroom M4A, leave it processing locally with bounded memory, hear a clearly intelligible teacher in a complete cleaned file, and save it. If a browser cannot support a required format or output workflow, the app explicitly explains the limitation and offers a practical local alternative.
