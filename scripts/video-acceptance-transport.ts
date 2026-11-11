import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface VideoAcceptanceObservation {
  method: "POST" | "GET" | "HEAD";
  httpStatus: number;
  elapsedMs: number;
}

/** Test instrumentation only. Never reads credentials, response bodies, task IDs or result URLs. */
export function singleSubmissionVideoTransport(
  request: typeof fetch,
  options: {
    submissionUrl: string;
    markerFile: string;
    privateRecoveryPermitted: true;
    observe?: (event: VideoAcceptanceObservation) => void | Promise<void>;
  },
): typeof fetch {
  if (options.privateRecoveryPermitted !== true)
    throw new Error(
      "Do not start a paid test without permission for its private recovery journal",
    );
  const submissionUrl = new URL(options.submissionUrl).href;
  const markerFile = path.resolve(options.markerFile);
  let claimed = false;
  return async (input, init = {}) => {
    const method =
      init.method?.toUpperCase() ??
      (input instanceof Request ? input.method.toUpperCase() : "GET");
    if (method !== "POST" && method !== "GET" && method !== "HEAD")
      throw new Error("Unsupported acceptance-test request method");
    if (method === "POST") {
      if (
        claimed ||
        new URL(input instanceof Request ? input.url : String(input)).href !==
          submissionUrl
      )
        throw new Error("This test permits only one generation submission");
      claimed = true;
      const directory = path.dirname(markerFile),
        info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      )
        throw new Error("Use a private acceptance-test directory");
      const handle = await open(
        path.join(await realpath(directory), path.basename(markerFile)),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, attemptedAt: new Date().toISOString() }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const started = Date.now();
    const response = await request(input, init);
    try {
      void Promise.resolve(
        options.observe?.({
          method,
          httpStatus: response.status,
          elapsedMs: Math.max(0, Date.now() - started),
        }),
      ).catch(() => {});
    } catch {
      /* Diagnostic failures must not prevent the provider from receiving and persisting the task ID. */
    }
    // Return the exact response object. Do not alias IDs, reshape JSON, or reinterpret task states here.
    return response;
  };
}
