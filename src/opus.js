const CLOCK_RATE = 48000;
const FRAME_US = 20000;
const PACKETS_PER_PAGE = 25;
const text = new TextEncoder();

const crcTable = Uint32Array.from({length: 256}, (_, byte) => {
  let value = byte << 24;
  for (let bit = 0; bit < 8; bit++) {
    value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  }
  return value;
});

export function compactBitrate(bytes, seconds) {
  const sourceBitrate = bytes * 8 / seconds;
  return Math.max(16000, Math.min(48000, Math.floor(sourceBitrate * 0.85 - 1000)));
}

export function opusConfig(sampleRate, bitrate) {
  return {
    codec: 'opus', sampleRate, numberOfChannels: 1, bitrate, bitrateMode: 'constant',
    opus: {frameDuration: FRAME_US}
  };
}

function oggPage(packets, flags, granule, serial, sequence) {
  const lacing = [];
  for (const packet of packets) {
    for (let bytes = packet.length; bytes >= 0; bytes -= 255) {
      lacing.push(Math.min(bytes, 255));
    }
  }
  const page = new Uint8Array(27 + lacing.length + packets.reduce((sum, p) => sum + p.length, 0));
  page.set(text.encode('OggS'));
  page[5] = flags;
  const view = new DataView(page.buffer);
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  let crc = 0;
  for (const byte of page) crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ byte];
  view.setUint32(22, crc, true);
  return page;
}

export class OggOpusEncoder {
  constructor(config, write) {
    this.rate = config.sampleRate;
    this.write = write;
    this.serial = crypto.getRandomValues(new Uint32Array(1))[0];
    this.sequence = 0;
    this.frames = 0;
    this.granule = 0;
    this.packets = [];
    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        try {
          if (this.preSkip === undefined) this.writeHeaders(metadata?.decoderConfig?.description);
          const packet = new Uint8Array(chunk.byteLength);
          chunk.copyTo(packet);
          this.granule += Math.round((chunk.duration ?? FRAME_US) * CLOCK_RATE / 1e6);
          this.packets.push({packet, granule: this.granule});
          // Leave the padded tail on the final page so its end granule can trim it.
          if (this.packets.length === PACKETS_PER_PAGE + 3) {
            const page = this.packets.splice(0, PACKETS_PER_PAGE);
            this.page(page.map(entry => entry.packet), 0, page.at(-1).granule);
          }
        } catch (error) {
          this.error = error;
        }
      },
      error: error => { this.error = error; }
    });
    this.encoder.configure(config);
  }

  page(packets, flags, granule) {
    this.write(oggPage(packets, flags, granule, this.serial, this.sequence++));
  }

  writeHeaders(description) {
    if (!description) throw new Error('The browser did not supply Opus export metadata. Choose WAV and try again.');
    const head = new Uint8Array(description);
    if (head.length < 19 || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') {
      throw new Error('The browser supplied invalid Opus export metadata.');
    }
    this.preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
    this.page([head], 2, 0);
    const vendor = text.encode('ClearLecture');
    const tags = new Uint8Array(16 + vendor.length);
    tags.set(text.encode('OpusTags'));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    this.page([tags], 0, 0);
  }

  push(bytes) {
    if (this.error) throw this.error;
    const frames = bytes.byteLength / 2;
    const audio = new AudioData({
      format: 's16', sampleRate: this.rate, numberOfFrames: frames, numberOfChannels: 1,
      timestamp: Math.round(this.frames * 1e6 / this.rate), data: bytes
    });
    try {
      this.encoder.encode(audio);
      this.frames += frames;
    } finally {
      audio.close();
    }
  }

  async finish() {
    const frames = this.frames;
    // Supply one extra frame so the encoder's lookahead contains the very end of the recording.
    this.push(new Uint8Array(2 * Math.ceil(this.rate * FRAME_US / 1e6)));
    await this.encoder.flush();
    if (this.error) throw this.error;
    const end = this.preSkip + Math.round(frames * CLOCK_RATE / this.rate);
    if (!this.packets.length || end > this.granule) throw new Error('The Opus export ended early.');
    this.page(this.packets.map(entry => entry.packet), 4, end);
    this.packets = [];
  }

  close() {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}
