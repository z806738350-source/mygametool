// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFile } from "node:fs/promises";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsSettings } from "../src/renderer/plugins.js";
import { PluginBuilderSessions } from "../src/renderer/plugin-builder.js";
import type { PluginDetail } from "../src/shared/plugins.js";

const official: PluginDetail = {
  id: "ohmygame:studio",
  name: "studio",
  displayName: "Studio",
  description: "Make games",
  source: { type: "builtIn" },
  marketplace: { id: "ohmygame", displayName: "OhMyGame" },
  installed: true,
  enabled: true,
  skills: [
    { id: "skills/studio/SKILL.md", name: "Studio skill", enabled: false },
  ],
  connections: [],
};
const imported: PluginDetail = {
  ...official,
  id: "marketplace:community:review",
  name: "review",
  displayName: "Community Review",
  source: {
    type: "git",
    url: "https://github.com/example/review",
    commit: "a".repeat(40),
  },
  marketplace: { id: "community", displayName: "Community" },
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let saved: unknown;
let plugins: PluginDetail[];
let removed: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/plugins";
  plugins = [structuredClone(official), structuredClone(imported)];
  saved = undefined;
  removed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = new URL(url, "http://localhost").pathname.replace(
        /^\/api/,
        "",
      );
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugins") return Response.json({ plugins, errors: [] });
      if (route === "/plugins/setup-sessions")
        return Response.json([
          {
            id: "workspace",
            pluginId: official.id,
            mode: "configure",
            title: "Configure Studio",
            status: "idle",
            createdAt: 0,
            updatedAt: 0,
          },
        ]);
      if (
        route === "/plugins/setup-sessions/workspace" &&
        init.method === "DELETE"
      ) {
        removed.push(route);
        return new Response(null, { status: 204 });
      }
      if (
        route === `/plugins/${encodeURIComponent(official.id)}/settings` &&
        init.method === "PUT"
      ) {
        saved = JSON.parse(init.body as string);
        plugins[0] = { ...plugins[0]!, enabled: false };
        return Response.json(plugins[0]);
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${route}`);
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await i18next.changeLanguage("en");
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectCollection(name: string) {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(tab => tab.textContent === name)!.click());
}

describe("Plugin library", () => {
  it.each(["zh-CN", "en"])("shows the bundled Blender workflows in %s and opens the matching English draft", async locale => {
    await i18next.changeLanguage(locale);
    const manifest = JSON.parse(await readFile("plugins/blender/.ohmygame-plugin/plugin.json", "utf8")).interface;
    expect(manifest.shortDescription).toBe(i18next.t("plugins.blender.description", { lng: "en" }));
    expect(manifest.longDescription).toBe(i18next.t("plugins.blender.about", { lng: "en" }));
    const blender: PluginDetail = {
      ...official, id: "ohmygame:blender", name: "blender", displayName: "Blender",
      description: manifest.shortDescription, longDescription: manifest.longDescription, defaultPrompts: manifest.defaultPrompt,
      skills: [{ id: "skills/blender-assets/SKILL.md", name: "Blender Assets", enabled: true }],
    };
    const personal: PluginDetail = { ...blender, id: "personal:blender", source: { type: "directory" },
      marketplace: imported.marketplace, description: "A separate plugin", longDescription: "A different workflow" };
    plugins = [blender, personal];
    const original = fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const route = decodeURIComponent(new URL(url, "http://localhost").pathname).replace(/^\/api/, "");
      const plugin = plugins.find(p => route === `/plugins/${p.id}`);
      if (plugin) return Response.json(plugin);
      if (route === "/projects") return Response.json([]);
      return original(url, init);
    });
    const onTry = vi.fn(async () => {});
    const show = async (id?: string) => act(async () => root.render(
      <PluginsSettings pluginId={id} onPluginChange={() => {}} onTryPlugin={onTry} />,
    ));
    await show();
    expect(container.querySelector(".plugin-card-description")?.textContent).toBe(i18next.t("plugins.blender.description"));
    await show(blender.id);
    expect(container.querySelector(".plugin-about p")?.textContent).toBe(i18next.t("plugins.blender.about"));
    expect(container.querySelector(".plugin-skills")?.textContent).toContain(i18next.t("plugins.blender.skillDescription"));
    const examples = [...container.querySelectorAll<HTMLButtonElement>(".plugin-prompts button")];
    const keys = ["fromReference", "fromModel", "procedural"] as const;
    expect(examples.map(button => button.querySelector(".plugin-prompt-text")?.textContent)).toEqual(keys.map(key => i18next.t(`plugins.blender.${key}`)));
    for (const [index, button] of examples.entries()) {
      await act(async () => button.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
      expect(onTry).toHaveBeenLastCalledWith(blender, manifest.defaultPrompt[index], undefined);
      expect(manifest.defaultPrompt[index]).toBe(i18next.t(`plugins.blender.${keys[index]!}`, { lng: "en" }));
    }
    await show(personal.id);
    expect(container.querySelector(".plugin-about p")?.textContent).toBe(personal.longDescription);
    expect(container.querySelector(".plugin-prompt-text")?.textContent).toBe(manifest.defaultPrompt[0]);
  });

  it("shows beta metadata on the matching card without marking other plugins", async () => {
    plugins[0]!.beta = true;
    await act(async () => root.render(<PluginsSettings onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    const betaCard = cards.find(card => card.textContent?.includes("Studio"))!;
    expect(betaCard.querySelector(".plugin-beta")?.textContent).toBe("Beta");
    expect(betaCard.querySelector('[aria-label="Disable Studio"]')).not.toBeNull();
    await selectCollection("Personal");
    expect(container.querySelector(".plugin-catalog-card .plugin-beta")).toBeNull();
  });

  it("groups official plugins under Public and user marketplace imports under Personal", async () => {
    await act(async () =>
      root.render(
        <PluginsSettings
          onPluginChange={() => {}}
          onTryPlugin={async () => {}}
        />,
      ),
    );
    expect(
      container.querySelector('[role="tabpanel"]')
        ?.textContent,
    ).toContain("Studio");
    expect(
      container.querySelector('[role="tabpanel"]')
        ?.textContent,
    ).not.toContain("Community Review");
    await selectCollection("Personal");
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(
      container.querySelector('[role="tabpanel"]')
        ?.textContent,
    ).toContain("Community Review");
    await selectCollection("Public");
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Disable Studio"]',
    )!;
    await act(async () => toggle.click());
    expect(saved).toEqual({ enabled: false, components: {} });
    expect(
      container
        .querySelector('[aria-label="Enable Studio"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(plugins[0]!.skills[0]!.enabled).toBe(false);
    expect(window.location.hash).toBe("#/plugins");
  });

  it("shows compact configuration workspaces with delete in the actions menu", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(<PluginBuilderSessions />));
    expect(
      container.querySelector(".plugin-builder-session-card"),
    ).not.toBeNull();
    expect(container.querySelector(".plugin-catalog-card")).toBeNull();
    const actions = container.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for Configure Studio"]',
    )!;
    await act(async () => actions.click());
    const remove = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((element) => element.textContent === "Delete")!;
    await act(async () => remove.click());
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Configure Studio"),
    );
    expect(removed).toEqual([]);
    confirm.mockReturnValue(true);
    await act(async () => actions.click());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((element) => element.textContent === "Delete")!
        .click(),
    );
    expect(removed).toEqual(["/plugins/setup-sessions/workspace"]);
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Configure Studio"),
    );
  });
});
