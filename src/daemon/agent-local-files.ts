import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mediaFileInfo } from "../shared/media-files.js";
import { isPrivateCredentialName } from "../shared/private-project-paths.js";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { lineDiff } from "../shared/line-diff.js";
import { CANVAS_BOARD_SCHEMA } from "../shared/canvas-workspace.js";
import { CanvasError, parseCanvasJson } from "./canvas-files.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { sniffImageType } from "./image-format.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import {
  isReadableAgentImageAttachment,
  parseAgentAttachmentReference,
  resolveAgentAttachment,
  type AuthorizeAgentAttachment,
} from "./agent-attachments.js";
import { INLINE_IMAGE_HIGH_BYTES } from "./session-images.js";
import { changeText, MAX_CHANGE_BYTES } from "./file-line-changes.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_ENTRIES = 2000;
const RASTER_IMAGE = /\.(?:png|jpe?g|webp)$/i;
const OTHER_BINARY_FILES = /\.(?:bmp|ico|tiff?|zip|pdf|woff2?|ttf)$/i;
const text = (value: string, details?: { diff: string }) => ({
  content: [{ type: "text" as const, text: value }],
  details,
});

class FilePolicyError extends Error {
  constructor(
    message: string,
    readonly reason:
      "unsafe_path" | "protected_content" | "authorization_denied",
  ) {
    super(message);
  }
}

/** Only call from a phase that cannot have changed project data. */
function rethrowPreflightPolicyFailure(cause: unknown): never {
  if (cause instanceof FilePolicyError)
    throw toolPreflightError(cause.message, cause.reason);
  if (
    cause instanceof Error &&
    ["EACCES", "EPERM"].includes(String((cause as NodeJS.ErrnoException).code))
  )
    throw toolPreflightError(cause.message, "authorization_denied");
  throw cause;
}

function fileDiff(
  before: string | undefined,
  content: string,
): { diff: string } | undefined {
  const after = changeText(Buffer.from(content));
  if (
    before === undefined ||
    after === undefined ||
    containsKnownSensitiveValue(before)
  )
    return;
  // Reuse the bounded comparison and the numbered display format understood by fileChangeMetadata.
  return {
    diff: lineDiff(before, after)
      .map((hunk) =>
        hunk
          .map(
            (line) =>
              `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.kind === "added" ? line.after : line.before} ${line.text}`,
          )
          .join("\n"),
      )
      .join("\n ...\n"),
  };
}

export function isPrivateProjectName(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.toLowerCase() === "node_modules" ||
    isPrivateCredentialName(name) ||
    containsKnownSensitiveValue(name)
  );
}

/** Reject symlinks at every existing component, including links whose target stays inside the project. */
export async function localAgentPath(
  workspace: string,
  requested: string,
  writing = false,
): Promise<string> {
  if (
    !requested ||
    requested.length > 4096 ||
    requested.includes("\0") ||
    path.isAbsolute(requested) ||
    /^[a-z]:/i.test(requested)
  ) {
    throw new FilePolicyError("Use a relative project path", "unsafe_path");
  }
  const parts = requested.split(/[\\/]/).filter((part) => part && part !== ".");
  if (
    parts.some(
      (part) =>
        part === ".." ||
        isPrivateProjectName(part) ||
        /[:\x00-\x1f]|[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new FilePolicyError(
      "Private, device or parent paths are unavailable to the agent",
      "unsafe_path",
    );
  }
  const workspaceEntry = await lstat(workspace);
  if (workspaceEntry.isSymbolicLink() || !workspaceEntry.isDirectory())
    throw new FilePolicyError(
      "The project root must be an ordinary directory",
      "unsafe_path",
    );
  const root = await realpath(workspace);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink())
        throw new FilePolicyError(
          "Symbolic links are unavailable to the agent",
          "unsafe_path",
        );
      if (index < parts.length - 1 && !entry.isDirectory())
        throw new Error("A parent path is not a directory");
    } catch (cause) {
      if (!writing || (cause as NodeJS.ErrnoException).code !== "ENOENT")
        throw cause;
    }
  }
  if (writing && !parts.length) throw new Error("Choose a project file");
  return current;
}

async function readText(file: string): Promise<string> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > MAX_FILE_BYTES)
      throw new Error("Read supports ordinary UTF-8 project files up to 1 MiB");
    if (entry.nlink !== 1)
      throw new FilePolicyError(
        "Hard-linked files are unavailable to the agent",
        "unsafe_path",
      );
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_FILE_BYTES)
      throw new Error("Binary or oversized files cannot be read as text");
    return decodeFileText(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function decodeFileText(bytes: Buffer): string {
  if (bytes.includes(0))
    throw new Error("Binary or oversized files cannot be read as text");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (containsKnownSensitiveValue(source))
    throw new FilePolicyError(
      "Project file contains protected credential data",
      "protected_content",
    );
  return source;
}

async function writeText(
  workspace: string,
  relative: string,
  content: string,
  signal?: AbortSignal,
): Promise<{ diff: string } | undefined> {
  const media = mediaFileInfo(relative);
  if (
    (media && media.contentType !== "image/svg+xml") ||
    OTHER_BINARY_FILES.test(relative)
  )
    throw toolPreflightError(
      "Write is text-only and cannot replace media files. Preserve the original; use file import or use_canvas_asset for existing Canvas media, and a new text path for code.",
      "unsafe_path",
    );
  if (containsKnownSensitiveValue(content))
    throw toolPreflightError(
      "Project file contains protected credential data",
      "protected_content",
    );
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES)
    throw toolPreflightError(
      "Write supports project files up to 1 MiB",
      "text_too_large",
    );
  let file: string;
  try {
    file = await localAgentPath(workspace, relative, true);
  } catch (cause) {
    rethrowPreflightPolicyFailure(cause);
  }
  // Validate before creating or truncating a board: an invalid Agent write otherwise
  // prevents the reader from loading it and blocks the editor's save/conflict recovery.
  const boardPath = path
    .relative(await realpath(workspace), file)
    .split(path.sep)
    .join("/")
    .match(/^canvas\/boards\/([^/]+)\.json$/i);
  if (boardPath) {
    let board: { id: string };
    try {
      board = parseCanvasJson<{ id: string }>(
        content,
        `boards/${boardPath[1]}.json`,
        CANVAS_BOARD_SCHEMA,
      );
    } catch (cause) {
      if (cause instanceof CanvasError)
        throw toolPreflightError(cause.message, "invalid_canvas_document");
      throw cause;
    }
    if (board.id !== boardPath[1])
      throw toolPreflightError(
        "Canvas board ID must match its file name",
        "invalid_canvas_document",
      );
  }
  // From mkdir onward an exception may follow a real filesystem change. Never
  // infer "no effect" from a later failure, even before content is truncated.
  await mkdir(path.dirname(file), { recursive: true });
  await localAgentPath(workspace, relative, true);
  // Do not truncate until the opened inode has also passed the private-file boundary.
  const handle = await open(
    file,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NONBLOCK |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n)
      throw new Error("Only ordinary, non-linked project files can be written");
    // Inspect the same inode before truncation, including binary files without media extensions.
    if (entry.size > BigInt(MAX_FILE_BYTES))
      throw new Error(
        "Write cannot replace an existing file above 1 MiB; preserve it and use a new path",
      );
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const original = bytes.subarray(0, bytesRead);
    if (bytesRead > MAX_FILE_BYTES || original.includes(0))
      throw new Error("Write cannot replace a binary or oversized file");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(original);
    } catch {
      throw new Error("Write cannot replace a binary file");
    }
    const before =
      bytesRead <= MAX_CHANGE_BYTES ? changeText(original) : undefined;
    signal?.throwIfAborted();
    const inspected = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (
      BigInt(bytesRead) !== entry.size ||
      inspected.size !== entry.size ||
      inspected.mtimeNs !== entry.mtimeNs ||
      inspected.ctimeNs !== entry.ctimeNs ||
      inspected.nlink !== 1n ||
      !current.isFile() ||
      current.dev !== entry.dev ||
      current.ino !== entry.ino ||
      (await localAgentPath(workspace, relative)) !== file
    )
      throw new Error(
        "Project file changed during inspection; retry without replacing the original",
      );
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
    return fileDiff(before, content);
  } finally {
    await handle.close();
  }
}

async function files(
  workspace: string,
  relative: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = await localAgentPath(workspace, relative);
  if ((await lstat(root)).isFile())
    return [
      path
        .relative(await realpath(workspace), root)
        .split(path.sep)
        .join("/"),
    ];
  const result: string[] = [];
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++visited > MAX_ENTRIES) return;
      if (isPrivateProjectName(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile())
        result.push(
          path
            .relative(await realpath(workspace), file)
            .split(path.sep)
            .join("/"),
        );
      if (visited > MAX_ENTRIES) return;
    }
  };
  await visit(root, 0);
  return result;
}

/** Filesystem-only tools. No subprocess, ambient SDK tool, plugin, or shell is registered. */
export function createLocalAgentFileTools(
  workspace: string,
  mutate?: <T>(operation: () => Promise<T>) => Promise<T>,
  allowImages = false,
  authorizeAttachment?: AuthorizeAgentAttachment,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool({
      name: "read",
      label: "Read project file",
      description: allowImages
        ? "Read a non-private UTF-8 file or PNG/JPEG/WebP image by relative project path. For a chat attachment in the current conversation branch, pass its exact attachment: reference. Images are read whole, without offset or limit. Preserve original images; never replace them with text placeholders."
        : "Read a non-private UTF-8 file by relative project path. For a text chat attachment in the current conversation branch, pass its exact attachment: reference. Image input is unavailable for this model. Preserve original media files.",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        const reference = parseAgentAttachmentReference(input.path);
        const assertAttachmentAllowed = async () => {
          signal?.throwIfAborted();
          if (
            reference &&
            (!authorizeAttachment ||
              !(await authorizeAttachment({ ...reference }, signal)))
          )
            throw new FilePolicyError(
              "This attachment reference is unavailable in the current conversation branch",
              "authorization_denied",
            );
          signal?.throwIfAborted();
        };
        await assertAttachmentAllowed();
        const attachment =
          reference && (await resolveAgentAttachment(workspace, reference));
        if (
          attachment &&
          attachment.kind !== "text" &&
          attachment.kind !== "image"
        )
          throw new Error(
            "Only UTF-8 text or PNG/JPEG/WebP image attachments can be read by attachment reference",
          );
        const file = attachment
          ? attachment.absolutePath
          : await localAgentPath(workspace, input.path);
        if (
          attachment
            ? attachment.kind === "image"
            : RASTER_IMAGE.test(input.path)
        ) {
          if (!allowImages)
            throw new FilePolicyError(
              "The selected connection does not have image input enabled; choose an image-enabled connection. Preserve the original image.",
              "authorization_denied",
            );
          if (input.offset !== undefined || input.limit !== undefined)
            throw new Error(
              "Image reads do not support text offset or limit; read the complete image",
            );
          if (attachment && !isReadableAgentImageAttachment(attachment))
            throw new Error(
              "Read supports PNG/JPEG/WebP attachments up to 20 MiB; preserve the original image",
            );
          const bytes = await readSafeProjectFile(
            workspace,
            file,
            attachment ? INLINE_IMAGE_HIGH_BYTES : undefined,
          );
          const mimeType = sniffImageType(bytes);
          if (
            !mimeType ||
            (attachment &&
              (attachment.mediaType !== mimeType ||
                attachment.size !== bytes.length))
          )
            throw new Error(
              "The file does not contain a supported PNG, JPEG or WebP image matching its metadata; preserve it and inspect its provenance.",
            );
          if (attachment) {
            // Lazy loading avoids the image utility's localAgentPath import cycle.
            const { validateConversationRaster } =
              await import("./image-working-assets.js");
            try {
              await validateConversationRaster(bytes);
            } catch {
              throw new Error(
                "The attachment is not a valid PNG, JPEG or WebP raster within the image decode limits; preserve the original",
              );
            }
          }
          await assertAttachmentAllowed();
          return {
            content: [
              {
                type: "image" as const,
                mimeType,
                data: bytes.toString("base64"),
              },
            ],
            details: undefined,
          };
        }
        const source = attachment
          ? decodeFileText(
              await readSafeProjectFile(workspace, file, MAX_FILE_BYTES),
            )
          : await readText(file);
        const lines = source
          .split("\n")
          .slice(
            (input.offset ?? 1) - 1,
            (input.offset ?? 1) - 1 + (input.limit ?? 200),
          );
        await assertAttachmentAllowed();
        return text(lines.join("\n").slice(0, MAX_OUTPUT));
      },
    }),
    defineTool({
      name: "write",
      label: "Write project file",
      description:
        "Write a UTF-8 text file by relative project path. Never overwrite images or other binary media with placeholders. Private files, parent paths and symlinks are unavailable. Canvas boards must match canvas/schemas/board.schema.json; asset nodes require data.assetId and data.mediaType (image, video, audio or model). Invalid boards are rejected before saving.",
      executionMode: "sequential",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        return text(
          "Project file saved.",
          await writeText(workspace, input.path, input.content, signal),
        );
      },
    }),
    defineTool({
      name: "edit",
      label: "Edit project file",
      description:
        "Replace one exact occurrence of oldText in a non-private UTF-8 project file. Paths must be relative. Canvas board edits are schema-validated before saving; asset nodes require data.assetId and data.mediaType (image, video, audio or model).",
      executionMode: "sequential",
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
      }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        let source: string;
        try {
          source = await readText(await localAgentPath(workspace, input.path));
        } catch (cause) {
          rethrowPreflightPolicyFailure(cause);
        }
        const index = source.indexOf(input.oldText);
        if (index < 0 || index !== source.lastIndexOf(input.oldText))
          throw toolPreflightError(
            "oldText must match exactly once",
            "edit_text_not_unique",
          );
        return text(
          "Project file edited.",
          await writeText(
            workspace,
            input.path,
            source.slice(0, index) +
              input.newText +
              source.slice(index + input.oldText.length),
            signal,
          ),
        );
      },
    }),
    defineTool({
      name: "ls",
      label: "List project directory",
      description:
        "List a relative project directory, excluding private names and symlinks. An omitted or empty path selects the project root.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        const entries = await readdir(
          await localAgentPath(workspace, input.path || "."),
          { withFileTypes: true },
        );
        return text(
          entries
            .filter(
              (entry) =>
                !isPrivateProjectName(entry.name) && !entry.isSymbolicLink(),
            )
            .slice(0, 1000)
            .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
            .join("\n"),
        );
      },
    }),
    defineTool({
      name: "find",
      label: "Find project files",
      description:
        "Find files whose relative project path contains a literal substring. An omitted or empty path selects the project root. This does not run a command or interpret a glob.",
      parameters: Type.Object({
        pattern: Type.String({ maxLength: 200 }),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_id, input, signal) =>
        text(
          (await files(workspace, input.path || ".", signal))
            .filter((file) => file.includes(input.pattern))
            .slice(0, 200)
            .join("\n"),
        ),
    }),
    defineTool({
      name: "grep",
      label: "Search project text",
      description:
        "Search non-private project files for a literal substring. An omitted or empty path selects the project root. No regex or command execution; output is bounded.",
      parameters: Type.Object({
        pattern: Type.String({ minLength: 1, maxLength: 200 }),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_id, input, signal) => {
        const matches: string[] = [];
        for (const file of await files(workspace, input.path || ".", signal)) {
          signal?.throwIfAborted();
          let source: string;
          try {
            source = await readText(await localAgentPath(workspace, file));
          } catch {
            continue;
          }
          for (const [index, line] of source.split("\n").entries()) {
            if (line.includes(input.pattern))
              matches.push(`${file}:${index + 1}:${line.slice(0, 500)}`);
            if (matches.length >= 200)
              return text(matches.join("\n").slice(0, MAX_OUTPUT));
          }
        }
        return text(matches.join("\n").slice(0, MAX_OUTPUT));
      },
    }),
  ];
  return tools.map((tool) => {
    if (["read", "ls", "find", "grep"].includes(tool.name)) {
      const execute = tool.execute;
      return {
        ...tool,
        execute: async (...args: Parameters<typeof execute>) => {
          try {
            return await execute(...args);
          } catch (cause) {
            rethrowPreflightPolicyFailure(cause);
          }
        },
      };
    }
    if (!mutate || !["write", "edit"].includes(tool.name)) return tool;
    const execute = tool.execute;
    return {
      ...tool,
      execute: (...args: Parameters<typeof execute>) =>
        mutate(() => execute(...args)),
    };
  });
}

/** Receipt-only access for agents whose ordinary filesystem tools stay inside the VM. */
/** A native agent's controlled reread after recovery; never an attachment or host-file fallback. */
export function createProjectFileReadTool(
  workspace: string,
  allowImages = false,
): ToolDefinition {
  const read = createLocalAgentFileTools(
    workspace,
    undefined,
    allowImages,
  ).find((tool) => tool.name === "read")!;
  return defineTool({
    ...read,
    name: "read_project_file",
    label: "Read current project file",
    description:
      "Read the current selected project's non-private file through OhMyGame's controlled file reader. Use this after retained-result recovery before further changes. Accepts project file paths only; chat attachments, URLs and files outside this project are refused. Image reading depends on the selected model's capabilities.",
    execute: async (...call) => {
      const input = call[1] as { path: string };
      if (
        typeof input.path !== "string" ||
        /^[a-z][a-z0-9+.-]*:/i.test(input.path)
      )
        throw toolPreflightError(
          "Use a current project file path; attachments and URLs cannot confirm a project reread",
          "authorization_denied",
        );
      await localAgentPath(workspace, input.path);
      return read.execute(...call);
    },
  });
}

export function createAgentAttachmentReadTool(
  workspace: string,
  allowImages: boolean,
  authorizeAttachment?: AuthorizeAgentAttachment,
): ToolDefinition {
  const read = createLocalAgentFileTools(
    workspace,
    undefined,
    allowImages,
    authorizeAttachment,
  ).find((tool) => tool.name === "read")!;
  return defineTool({
    name: "read_attachment",
    label: "Read chat attachment",
    description:
      "Read an exact attachment:batch/id reference authorized in the current conversation branch. Supports UTF-8 text up to 1 MiB and complete PNG/JPEG/WebP images up to 20 MiB for image-enabled models. Project paths, URLs and host paths are unavailable. Preserve original files.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (id, input, signal, onUpdate, context) => {
      if (!parseAgentAttachmentReference(input.path))
        throw new Error(
          "Use an exact attachment:batch/id reference from the current conversation branch",
        );
      const result = await read.execute(id, input, signal, onUpdate, context);
      return result.content.some(block => block.type === "image") ? {
        ...result,
        content: [{ type: "text" as const, text: "The original attachment is included as an image content block. OhMyGame did not generate a text caption; provider-side processing is not visible to this tool." }, ...result.content],
      } : result;
    },
  });
}
