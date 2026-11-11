import type { KeyboardEvent } from "react";
import { t } from "./i18n.js";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";

export interface TransferredFile { file: File; relativePath?: string }

export function hasTransferredFiles(transfer: DataTransfer): boolean {
  return transfer.types.includes("Files") || [...transfer.items].some((item) => item.kind === "file");
}

export function clipboardFiles(transfer: DataTransfer): File[] {
  if (transfer.files.length) return [...transfer.files].filter((file) => allowedTransferPath(file.webkitRelativePath || file.name));
  return [...transfer.items].flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file && allowedTransferPath(file.webkitRelativePath || file.name) ? [file] : []; });
}

export async function transferredFiles(transfer: DataTransfer): Promise<TransferredFile[]> {
  // Capture entries before the browser clears the event's data store.
  const items = [...transfer.items].filter((item) => item.kind === "file");
  const sources = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  if (!sources.some((source) => source.entry)) return clipboardFiles(transfer).map((file) => ({ file, ...(file.webkitRelativePath ? { relativePath: file.webkitRelativePath } : {}) }));
  return (await Promise.all(sources.map(({ entry, file }) => entry ? filesFromEntry(entry) : Promise.resolve(file && allowedTransferPath(file.webkitRelativePath || file.name) ? [{ file }] : [])))).flat();
}

function filesFromEntry(entry: FileSystemEntry, prefix = ""): Promise<TransferredFile[]> {
  if (!allowedTransferPath(`${prefix}${entry.name}`)) return Promise.resolve([]);
  if (entry.isFile) return new Promise((resolve, reject) => {
    (entry as FileSystemFileEntry).file((file) => resolve([{ file, relativePath: `${prefix}${file.name}` }]), () => reject(new Error(t("attachments.readFailed", { name: `${prefix}${entry.name}` }))));
  });
  if (!entry.isDirectory) return Promise.resolve([]);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(entries); else { entries.push(...batch); next(); } }, reject);
    next();
  }).then(async (entries) => (await Promise.all(entries.map((child) => filesFromEntry(child, `${prefix}${entry.name}/`)))).flat());
}

const nativePastes = new WeakSet<HTMLElement>();
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function pasteNativeFiles(event: KeyboardEvent<HTMLElement>, onFiles: (files: TransferredFile[]) => void, onError?: (error: Error) => void): void {
  const clipboard = window.ohMyGameDesktop?.clipboard;
  if (!clipboard || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "v") return;
  event.preventDefault();
  const target = event.target as HTMLElement;
  if (nativePastes.has(target)) return;
  nativePastes.add(target);
  void clipboard.files().then(async (files) => {
    if (!target.isConnected || document.activeElement !== target) return;
    if (!files.length) { await clipboard.paste(); return; }
    onFiles(files.filter(({ name, relativePath }) => allowedTransferPath(relativePath || name)).map(({ name, relativePath, bytes, lastModified }) => ({
      relativePath,
      file: new File([new Uint8Array(bytes)], name, { lastModified, type: IMAGE_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "" }),
    })));
  }).catch((cause) => onError?.(cause instanceof Error ? cause : new Error(String(cause))))
    .finally(() => nativePastes.delete(target));
}

function allowedTransferPath(value: string): boolean {
  return Boolean(value) && !/^(?:[/\\]|[a-z]:)/i.test(value) && !value.includes("\0") && !value.split(/[\\/]/).some((part) => part === "." || part === "..") && !isPrivateProjectPath(value);
}
