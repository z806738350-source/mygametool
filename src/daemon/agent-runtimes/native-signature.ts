import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Ask macOS to verify the actual signed bytes and the expected publisher. */
export async function verifyNativeDeveloperId(
  file: string,
  identifier: string,
  team: string,
): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("Developer ID verification requires macOS");
  const requirement =
    `identifier "${identifier}" and anchor apple generic and ` +
    "certificate 1[field.1.2.840.113635.100.6.2.6] and " +
    "certificate leaf[field.1.2.840.113635.100.6.1.13] and " +
    `certificate leaf[subject.OU] = "${team}"`;
  await run("/usr/bin/codesign", [
    "--verify", "--strict", `-R=${requirement}`, "--", file,
  ], { timeout: 15_000, maxBuffer: 16 * 1024 });
}
