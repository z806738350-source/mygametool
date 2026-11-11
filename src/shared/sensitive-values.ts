// Process-local only. Keep removed credentials registered so older errors stay redacted.
const sensitiveValues = new Set<string>();
let revision = 0;
const revisionListeners = new Set<() => void>();

export function registerSensitiveValue(value: string | undefined): void {
  if (!value) return;
  const before = sensitiveValues.size;
  sensitiveValues.add(value);
  sensitiveValues.add(JSON.stringify(value).slice(1, -1));
  try {
    const encoded = encodeURIComponent(value);
    sensitiveValues.add(encoded);
    sensitiveValues.add(encoded.replace(/%20/g, "+"));
    sensitiveValues.add(encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
  } catch { /* An invalid Unicode sequence still has its literal and JSON forms. */ }
  if (sensitiveValues.size !== before) {
    revision += 1;
    for (const listener of revisionListeners) {
      try { listener(); }
      catch { /* Observers cannot prevent registering protected data. */ }
    }
  }
}

/** A policy generation only; no registered values leave this module. */
export function knownSensitiveValueRevision(): number {
  return revision;
}
/** Invalidation only: callbacks never receive credentials or their representations. */
export function onSensitiveValueRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
}

/** Exact registered values only; this is not a scanner for arbitrary source-file secrets. */
export function redactKnownSensitiveValues(text: string): string {
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    text = text.split(value).join("[redacted]");
  }
  return text;
}

/** Daemon consumers can check content without obtaining the registered credentials. */
export function containsKnownSensitiveValue(text: string): boolean {
  return [...sensitiveValues].some((value) => text.includes(value));
}

export function knownSensitiveValueOverlap(): number {
  return Math.max(0, ...[...sensitiveValues].map((value) => value.length - 1));
}

/** Hold incomplete values across log frames before releasing any text. */
export function sensitiveValueStream(): (text: string, final?: boolean) => string {
  let pending = "";
  return (text, final = false) => {
    pending += text;
    let end = final ? pending.length : Math.max(0, pending.length - knownSensitiveValueOverlap());
    let previous: number;
    do {
      previous = end;
      for (const value of sensitiveValues) {
        const start = pending.indexOf(value, Math.max(0, end - value.length + 1));
        if (start >= 0 && start < end && start + value.length > end) end = start;
      }
    } while (end !== previous);
    const output = redactKnownSensitiveValues(pending.slice(0, end));
    pending = pending.slice(end);
    return output;
  };
}
