import { afterEach, describe, expect, it, vi } from "vitest";
import { readCanvasDraftStatus, registerCanvasDraftReader } from "../src/renderer/canvas-draft-safety.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { CanvasMarkdownDocument } from "../src/shared/canvas-document.js";
import type { CanvasTable } from "../src/shared/canvas-table.js";

function memoryStorage(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  return {
    entries,
    get length() {
      return entries.size;
    },
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => entries.set(key, value)),
    removeItem: vi.fn((key: string) => entries.delete(key)),
    clear: vi.fn(() => entries.clear()),
  };
}

function boardDraft(dirty = false) {
  const base = createAssetCanvasDocument();
  base.nodes = [
    {
      id: "image-node",
      type: "asset",
      position: { x: 0, y: 0 },
      data: { assetId: "retained-library-image", mediaType: "image" },
    },
  ];
  base.editorLayout.nodes["image-node"] = base.nodes[0]!.position;
  const local = structuredClone(base);
  if (dirty) {
    local.nodes[0]!.position.x = 32;
    local.editorLayout.nodes["image-node"]!.x = 32;
  }
  return { base, local };
}

function documentDrafts(dirty = false) {
  const document: CanvasMarkdownDocument = {
    id: "document",
    title: "Rules",
    markdown: "",
  };
  return [
    {
      base: { document, revision: "saved-revision" },
      local: {
        ...document,
        markdown: dirty ? "![Retained image](../../assets/hero.png)" : "",
      },
    },
  ];
}

function tableDrafts(dirty = false) {
  const table: CanvasTable = {
    version: 1,
    id: "table",
    title: "Assets",
    columns: [{ id: "file", title: "File", type: "text" }],
    rows: [{ id: "hero", cells: { file: "" } }],
  };
  const local = structuredClone(table);
  if (dirty) local.rows[0]!.cells.file = "../../assets/hero.png";
  return [{ base: { table, revision: "saved-revision" }, local }];
}

const draftKinds = [
  {
    kind: "board",
    key: "canvas-board:project-one:board-one",
    draft: boardDraft,
  },
  {
    kind: "documents",
    key: "canvas-documents:project-two",
    draft: documentDrafts,
  },
  { kind: "tables", key: "canvas-tables:project-three", draft: tableDrafts },
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("canvas draft safety", () => {
  it("checks only the requested project, including retained versions, without changing drafts", () => {
    const storage = memoryStorage({
      "canvas-board:project-ab:board": "malformed",
      "canvas-documents:other-project": "malformed",
      "canvas-document-generations:other-project": "malformed",
      "canvas-board:project-a:board:old-version": JSON.stringify(boardDraft(true)),
    });
    const before = [...storage.entries];
    expect(readCanvasDraftStatus(storage, "project-a")).toBe("pending");
    expect(readCanvasDraftStatus(storage, "project-clear")).toBe("clear");
    expect([...storage.entries]).toEqual(before);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    storage.entries.set("canvas-tables:project-a:older-version", "malformed");
    expect(readCanvasDraftStatus(storage, "project-a")).toBe("unknown");
  });

  it.each(["canvas-document-generations", "canvas-table-generations"])("protects unsaved %s proposals and fails closed on unreadable state", (prefix) => {
    const proposal = prefix === "canvas-document-generations" ? "candidate" : tableDrafts(true)[0]!.local;
    const storage = memoryStorage({ [`${prefix}:project-a`]: JSON.stringify({ item: { instruction: "", proposal } }) });
    expect(readCanvasDraftStatus(storage, "project-a")).toBe("pending");
    storage.entries.set(`${prefix}:project-a`, "not-json");
    expect(readCanvasDraftStatus(storage, "project-a")).toBe("unknown");
    storage.entries.set(`${prefix}:project-a`, JSON.stringify({ item: { unexpected: true } }));
    expect(readCanvasDraftStatus(storage, "project-a")).toBe("unknown");
  });

  it("checks project-scoped memory readers and unregisters only the matching reader", () => {
    const storage = memoryStorage();
    let status: "clear" | "pending" | "unknown" = "pending";
    const stop = registerCanvasDraftReader("memory-a", () => status);
    const other = registerCanvasDraftReader("memory-b", () => "unknown");
    try {
      expect(readCanvasDraftStatus(storage, "memory-a")).toBe("pending");
      expect(readCanvasDraftStatus(storage, "memory-clear")).toBe("clear");
      status = "unknown";
      expect(readCanvasDraftStatus(storage, "memory-a")).toBe("unknown");
      stop();
      expect(readCanvasDraftStatus(storage, "memory-a")).toBe("clear");
      expect(readCanvasDraftStatus(storage, "memory-b")).toBe("unknown");
    } finally { stop(); other(); }
  });

  it("reports clear for accessible empty storage and ignores unrelated keys", () => {
    expect(readCanvasDraftStatus(memoryStorage())).toBe("clear");
    const storage = memoryStorage({
      "canvas-active:project-one": "not-json",
      "canvas-document-generations:project-one": "not-json",
      "canvas-table-generations:project-one": "not-json",
      "composer-draft:conversation": "not-json",
    });
    expect(readCanvasDraftStatus(storage)).toBe("clear");
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it.each(["canvas-documents:project", "canvas-tables:project"])(
    "treats the empty %s draft list as clear",
    (key) => {
      expect(readCanvasDraftStatus(memoryStorage({ [key]: "[]" }))).toBe(
        "clear",
      );
    },
  );

  describe.each(draftKinds)("$kind recovery drafts", ({ key, draft }) => {
    it("reports clear when the valid local state equals its base", () => {
      const storage = memoryStorage({ [key]: JSON.stringify(draft()) });
      expect(readCanvasDraftStatus(storage)).toBe("clear");
    });

    it("protects pending changes in an unrelated project's older workspace version", () => {
      const storage = memoryStorage({
        "canvas-board:another-project:another-board":
          JSON.stringify(boardDraft()),
        [`${key}:older-restored-version`]: JSON.stringify(draft(true)),
      });
      expect(readCanvasDraftStatus(storage)).toBe("pending");
    });

    it.each(["not-json", "null", "{}", "[null]"])(
      "does not classify malformed recovery data %j as clear",
      (value) => {
        expect(readCanvasDraftStatus(memoryStorage({ [key]: value }))).toBe(
          "unknown",
        );
      },
    );
  });

  it("accepts old content-node sizes only in memory without rewriting recovery data", () => {
    const draft = boardDraft();
    for (const state of [draft.base, draft.local]) {
      state.nodes[0]!.width = 300;
      state.nodes[0]!.height = 200;
      Object.assign(state.editorLayout.nodes["image-node"]!, {
        width: 300,
        height: 200,
      });
    }
    const raw = JSON.stringify(draft);
    const storage = memoryStorage({ "canvas-board:legacy:board": raw });
    expect(readCanvasDraftStatus(storage)).toBe("clear");
    expect(storage.entries.get("canvas-board:legacy:board")).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it.each([
    {
      key: "canvas-board:project:board",
      invalid: { base: boardDraft().base, local: { nodes: [] } },
    },
    {
      key: "canvas-documents:project",
      invalid: [
        {
          base: { document: documentDrafts()[0]!.local },
          local: documentDrafts()[0]!.local,
        },
      ],
    },
    {
      key: "canvas-tables:project",
      invalid: [
        {
          base: tableDrafts()[0]!.base,
          local: { ...tableDrafts()[0]!.local, columns: [] },
        },
      ],
    },
  ])("rejects invalid $key schemas", ({ key, invalid }) => {
    expect(
      readCanvasDraftStatus(memoryStorage({ [key]: JSON.stringify(invalid) })),
    ).toBe("unknown");
  });

  it.each([true, false])(
    "gives unknown priority over pending regardless of iteration order (%s)",
    (unknownFirst) => {
      const entries: Array<[string, string]> = [
        ["canvas-board:dirty:board", JSON.stringify(boardDraft(true))],
        ["canvas-documents:unreadable", "malformed-json"],
      ];
      if (unknownFirst) entries.reverse();
      const storage = memoryStorage(Object.fromEntries(entries));
      const before = [...storage.entries];
      expect(readCanvasDraftStatus(storage)).toBe("unknown");
      expect([...storage.entries]).toEqual(before);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.clear).not.toHaveBeenCalled();
    },
  );

  it.each(["length", "key", "getItem"] as const)(
    "reports unknown when storage %s cannot be read",
    (operation) => {
      const storage = memoryStorage({
        "canvas-board:project:board": JSON.stringify(boardDraft()),
      });
      const fail = () => {
        throw new DOMException("Storage unavailable", "SecurityError");
      };
      if (operation === "length")
        Object.defineProperty(storage, "length", { get: fail });
      else storage[operation].mockImplementation(fail);
      expect(readCanvasDraftStatus(storage)).toBe("unknown");
    },
  );

  it("uses the supplied storage without touching the global storage getter", () => {
    vi.stubGlobal("localStorage", undefined);
    const access = vi.fn(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: access,
    });
    expect(readCanvasDraftStatus(memoryStorage())).toBe("clear");
    expect(access).not.toHaveBeenCalled();
    expect(readCanvasDraftStatus()).toBe("unknown");
    expect(access).toHaveBeenCalledOnce();
  });

  it("uses the default local storage only after the helper is called", () => {
    const storage = memoryStorage({
      "canvas-documents:project:retained-version": JSON.stringify(
        documentDrafts(true),
      ),
    });
    vi.stubGlobal("localStorage", storage);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(readCanvasDraftStatus()).toBe("pending");
  });
});
