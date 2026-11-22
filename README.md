# ClearLecture — private, local lecture audio cleanup

ClearLecture is a static browser app for conservative cleanup of long, single-speaker classroom recordings. Audio stays in the browser. There is no upload endpoint, analytics, account, microphone capture, or third-party runtime dependency. A service worker caches the app shell after the first successful online load; audio files and output are never cached.

## Run locally

Requires Node.js 22+ for the included test runner flag (no install step):

```sh
npm run dev
# open http://localhost:4173 in recent Chrome or Edge
```

The save picker writes output chunks directly to the destination file, one acknowledged chunk at a time. In browsers without the File System Access API, browser download mode builds a Blob in memory; the app requires explicit opt-in and refuses it when estimated WAV output exceeds 192 MiB. For long recordings use an up-to-date Chromium browser, an available destination with enough free space, and PCM WAV or a supported AAC-LC M4A.

## Build and deploy to Cloudflare Pages

```sh
npm run build
```

Deploy the generated `dist/` directory as a static Pages site. In Cloudflare Pages, create a Pages project, choose the repository, set the build command to `npm run build`, and set the build output directory to `dist`. No Worker, Functions, environment variables, database, or audio service is needed. Direct Upload can publish the contents of `dist/`. Serve over HTTPS so WebCodecs, the service worker, and the save picker are available.

## Formats and browser behavior

| Input | Support |
|---|---|
| Standard PCM WAV, 16/24/32-bit integer or 32-bit float | Streaming reads; mono mixdown; extensible WAV PCM/float subformats accepted |
| AAC-LC in a conventional single-track M4A/MP4 | Progressive box scan, compact sample reads, WebCodecs `AudioDecoder` required |
| MP3, Opus/WebM, ALAC, HE-AAC, DRM, fragmented MP4, RF64/BW64 | Not supported by the in-browser build; use the local FFmpeg path below |

Output is mono PCM16 WAV. For input rates at or above 32 kHz the app outputs half the input rate (e.g. 48 kHz → 24 kHz); lower rates remain unchanged. This is intended for speech, not music mastering. Standard RIFF WAV has a 4 GB size limit. The app estimates output size and stops before processing if that limit would be exceeded.

Long AAC is demuxed in small ranges from the local `File`; the complete encoded file is not read into one buffer. Decoded `AudioData` frames are mixed using the selected average/left/right mode and passed to the worker DSP. Worker output is transferred to the page and processing waits for a write acknowledgement before continuing, bounding queued output. File picker and WebCodecs support vary by browser. If the save picker is unavailable, memory export requires an explicit checkbox and is refused above the 192 MiB estimated WAV size.

### Known container caveat

The small MP4 demuxer supports ordinary AAC-LC sample tables (`stsz`, `stsc`, `stco`/`co64`, `stts`) and scans top-level boxes progressively, including an end-positioned `moov`. It applies the common edit-list shape with one media edit and an optional preceding empty edit, trimming the declared AAC priming and matching the playable duration. It refuses multiple/reordered edits and unsupported playback rates. This path has passed the included AAC fixture in Chromium; there is not yet a broad corpus of phone/recorder MP4 variants, so compare start/end alignment on important recordings.

## DSP and listening guidance

The worker runs a DC/rumble high-pass, speech-band low-pass, isolated one-sample spike repair, smoothed STFT spectral subtraction, restrained RMS leveling, soft peak compression, and windowed-sinc anti-alias downsampling. Stages can be disabled in Advanced processing controls. A conservative sample ceiling remains active as an output safety guard even if soft compression is disabled; this is not a true-peak limiter. There is no neural source separation, transcription, speech deletion, or de-reverb module. The noise estimate adapts from the signal; this is a simple classical algorithm, not a robust learned classifier. Strong settings can damage consonants or sound watery. Use Gentle if that happens.

On selection, the app analyzes short windows near the beginning, middle and end. It displays a waveform envelope and relative spectrum for the middle window, and provides a conservative preset recommendation. The “quiet-window level” is a proxy based on low 20 ms frame RMS, not a separated noise floor; “speech-like activity” is a level threshold heuristic, not speech recognition or a voice detector. Hum and transient counts are candidates and can be wrong. The analysis is computed locally and only uses representative windows.

The result report gives input/output sample peak and RMS plus the count of samples near full scale. These measurements do not establish intelligibility, true peak, clipping audibility, or noise-floor improvement. No post-clean sample analysis is claimed. Listen to original and cleaned audio with the time-preserving A/B switch. A click or chair sound directly overlapping speech may not be removable without also damaging the voice. Quiet speech is not intentionally gated or deleted.

There is no de-reverb because this build does not have a defensible detector or implementation, no 24-bit export, configurable resampling or compressed browser output. MP3, Opus/WebM, ALAC, HE-AAC, DRM, fragmented MP4 and RF64/BW64 are not supported in-browser. Use the separate local FFmpeg script for those inputs. The unused MP3 parser experiment is not wired into the product and is not a supported format.

## Optional local FFmpeg batch path

For compact AAC output or unsupported formats, run FFmpeg locally:

```sh
bash scripts/clean_ffmpeg.sh "original.m4a" "cleaned.m4a" balanced
# gentle or strong are also accepted
```

The script uses FFmpeg highpass/lowpass/adeclick/afftdn/acompressor/loudnorm filters and AAC encoding. This is a separate implementation from the browser DSP; its filters, results, and codecs differ. FFmpeg and its filter/codec build must be installed on the user's computer. It is optional and is not called by the site.

## Test and verification

```sh
npm test
npm run test:e2e
npm run build
```

The browser smoke requires Node 22+ plus an installed Microsoft Edge/Chrome/Chromium. Set `CLEARLECTURE_BROWSER` to its executable if it is not in a standard location. To use an already running local Chromium remote-debugging session instead, set `CLEARLECTURE_CDP_URL` (for example `http://127.0.0.1:9222`).

For a reproducible streaming DSP-only benchmark, run `npm run bench:dsp -- 60` (or pass 90). It creates deterministic synthetic voice-like audio in small chunks and discards encoded output after counting it. A previous run on Windows build 26200 (AMD Ryzen 7 4800H, 16 logical CPUs, Node 24.18.0) completed in 47.15 seconds (76.35× real time); Node RSS rose from 46.9 MiB to 53.6 MiB, and the run emitted the expected 86.4 million 24 kHz samples. This measures the DSP and synthetic source generator only; it does not benchmark MP4 decoding, browser file writes, full-worker memory, or real classroom quality. The run script reports fresh measurements on the machine where it is executed.

Tests use generated/synthetic fixtures only; no private classroom recordings are included. Unit tests cover FFT round trip, untreated STFT reconstruction, chunk-boundary invariance, alias suppression, click repair, silence/NaN handling, exact output lengths, WAV headers/downmix/stream reads, analysis metrics and the sample-table parser against the included synthetic M4A. `npm run test:e2e` runs a dependency-free Chromium/Edge DevTools Protocol smoke test (Node 22+ and a local browser required): it checks AAC→WAV decode, duration, sample bounds, download, WAV reopen, cancellation/retry, and absence of cross-origin requests. A real browser session completed the AAC analysis, cancel/retry and WAV fixture path. The standalone runner could not spawn Edge in the restricted environment (`EPERM`); run that command on an unrestricted workstation for the automated end-to-end report. The File System Access save picker and 60–90-minute browser runtime/memory have not been measured here. Do not interpret fixture checks as a long-file performance certification.

No full-pipeline runtime or memory target is claimed. A representative browser benchmark should record browser/version, OS, CPU/RAM, source duration/codec/rate/channels, wall time, peak process memory, output size, and verify duration/alignment and listening quality. The DSP-only result above cannot substitute for testing M4A decode and destination writes on long real recordings. The fixture suite is not a substitute for human A/B listening on varied classroom recordings.

## Project map

- `src/main.js`: accessible file flow, save/write acknowledgements, previews, cancellation and report
- `src/worker.js`: WAV/M4A input, WebCodecs decode, bounded streaming DSP orchestration
- `src/mp4.js`: minimal conventional AAC-LC MP4 demuxer
- `src/wav.js`: streaming PCM WAV input and PCM16 RIFF output
- `src/dsp.js`: FFT, overlap-add, filters, click repair, noise suppression, leveling, peak control and anti-alias resampling
- `src/audio.js`: shared stereo-to-mono channel selection
- `sw.js`: caches only static app assets for offline shell use
- `favicon.svg`: local install/site icon
- `scripts/clean_ffmpeg.sh`: optional local compressed-output alternative
- `tests/`: deterministic synthetic fixtures and Node unit/integration tests

## Audit summary and prioritized remaining work

The starter already had a backend-free worker design, progressive MP4 sample reads, WAV streaming, a disk writer acknowledgement, and a small synthetic test set. The first test run passed all six original tests. This update adds module overrides, A/B preview, accurate exported-PCM peak/RMS metrics, RIFF bounds and extensible WAV handling, edit-list/priming alignment for a common AAC layout, explicit stereo channel choice, a windowed-sinc anti-alias resampler, static build/dev commands, offline app-shell caching, a guarded in-memory export fallback, and repeatable unit/browser smoke tests.

Remaining production gaps: there is no true noise-floor or speech detector, no post-clean quality report, no MP3/Opus input or compressed browser output, no 24-bit export, and no measured full browser 60–90-minute decode/write run. The automated browser smoke uses Chromium's DevTools Protocol rather than the Playwright package. Direct-to-file free-space checks are not portable and remain the user's responsibility. Browser/OS may keep decoder-internal buffers beyond app control. Before relying on a particular recorder/browser combination, run the AAC fixture end-to-end, process a long non-private sample, check its duration/start/end, and listen to original/cleaned sections (including quiet speech and consonant-heavy passages) at matched playback level. These human and long-file checks have not been performed here. The app is a production-ready static release candidate for the explicitly supported path, with those device-specific release checks still outstanding.
