/** Synthetic PCM tone; no user recording or encoder dependency. */
export function referenceWav(seconds = 1, rate = 8_000, channels = 1): Buffer {
  const samples = Math.round(seconds * rate), bytes = samples * channels * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + bytes, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples * channels; i++) wav.writeInt16LE(Math.round(2_000 * Math.sin(2 * Math.PI * 440 * Math.floor(i / channels) / rate)), 44 + i * 2);
  return wav;
}

/** MPEG-1 Layer III silent frames, about one second at 44.1 kHz. */
export function referenceMp3(): Buffer {
  return Buffer.concat(Array.from({ length: 40 }, () => {
    const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x00]); return frame;
  }));
}
