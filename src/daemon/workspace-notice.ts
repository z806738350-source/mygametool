import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import type { ProjectState } from "../shared/contracts.js";
import { writeAtomically } from "./checkpoint-objects.js";

type Project = Pick<ProjectState, "workspacePath" | "storagePath">;
const noticePath = (project: Project) =>
  path.join(
    project.storagePath ?? path.dirname(project.workspacePath),
    "workspace-restore-notice.txt",
  );
/** Outside creative files: an interrupted restore must still inform future
 * model requests even if recording an individual session failed. */
export async function writeWorkspaceNotice(
  project: Project,
  notice: string,
  version: string = randomUUID(),
): Promise<void> {
  const target = noticePath(project);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(
    path.dirname(target),
    target,
    `[workspace-version:${version}]\n${notice}`,
  );
}
export async function readWorkspaceNotice(
  project: Project,
): Promise<string | undefined> {
  try {
    return (await readFile(noticePath(project), "utf8")).replace(
      /^\[workspace-version:[^\]]+\]\n/,
      "",
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
export async function readWorkspaceVersion(project: Project, requireExisting = false): Promise<string> {
  try {
    const file = await open(noticePath(project), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) throw new Error("Workspace restore notice must be a regular file");
      // Only the fixed first line carries an epoch. The full notice may list many changed paths.
      const notice = await text(file.createReadStream({ end: 64 }));
      if ("[workspace-version:".startsWith(notice))
        throw new Error("Incomplete version in workspace restore notice");
      if (!notice.startsWith("[workspace-version")) return "0"; // Legacy notices predate workspace versions.
      const header = /^\[workspace-version:(0|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\](?:\r?\n|$)/.exec(notice);
      if (!header) throw new Error("Invalid version in workspace restore notice");
      return header[1]!;
    } finally {
      await file.close();
    }
  } catch (cause) {
    // Once an existing notice was unreadable, its temporary removal cannot prove the original workspace epoch.
    if (!requireExisting && (cause as NodeJS.ErrnoException).code === "ENOENT") return "0";
    throw cause;
  }
}
