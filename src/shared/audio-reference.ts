import { BufferSource, Input, MP3, WAVE } from "mediabunny";

export const AUDIO_REFERENCE_MAX_BYTES = 10_000_000;
export const AUDIO_REFERENCE_MAX_SECONDS = 30;

/** Detect local uploads from bounded bytes; an existing asset's MIME must still match. */
export async function inspectAudioReference(bytes: Uint8Array, mediaType?: string): Promise<{ mediaType: "audio/mpeg" | "audio/wav"; duration: number }> {
  if (!bytes.byteLength || bytes.byteLength > AUDIO_REFERENCE_MAX_BYTES) throw new Error("Reference audio must be nonempty and at most 10 MB");
  if (mediaType !== undefined && mediaType !== "audio/mpeg" && mediaType !== "audio/wav") throw new Error("Reference audio supports MP3 or WAV only");
  const input = new Input({ source: new BufferSource(bytes), formats: [MP3, WAVE] });
  const timer = setTimeout(() => input.dispose(), 3000);
  try {
    const format = await input.getFormat();
    if (format !== MP3 && format !== WAVE || mediaType !== undefined && format !== (mediaType === "audio/wav" ? WAVE : MP3)) throw new Error();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error();
    const duration = await input.computeDuration([track], { skipLiveWait: true });
    if (!Number.isFinite(duration) || duration <= 0 || duration > AUDIO_REFERENCE_MAX_SECONDS) throw new Error();
    return { mediaType: format === WAVE ? "audio/wav" : "audio/mpeg", duration };
  } catch { throw new Error("Reference audio must be a valid MP3 or WAV of 30 seconds or less"); }
  finally { clearTimeout(timer); input.dispose(); }
}
