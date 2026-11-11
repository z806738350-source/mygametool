import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOhMyGamePiEnvironment,
  withoutOhMyGameManagedPiPackages,
} from "../src/daemon/pi-agent.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("OhMyGame Pi environment", () => {
  it("removes only the legacy app-managed MCP adapter package", () => {
    const configured = [
      "npm:pi-web-access",
      { source: "npm:pi-mcp-adapter@2.27.0", extensions: ["extensions/index.ts"] },
      "github:example/custom-extension",
    ];
    expect(withoutOhMyGameManagedPiPackages(configured)).toEqual([
      "npm:pi-web-access",
      "github:example/custom-extension",
    ]);
    const userPackages = ["npm:pi-web-access"];
    expect(withoutOhMyGameManagedPiPackages(userPackages)).toBe(userPackages);
  });

  it("migrates the legacy adapter setting while preserving user packages", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    directories.push(agentDir);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      packages: [
        "npm:pi-web-access",
        "npm:pi-mcp-adapter@2.27.0",
        { source: "github:example/custom-extension", extensions: [] },
      ],
    }));

    await ensureOhMyGamePiEnvironment(agentDir);

    expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).packages).toEqual([
      "npm:pi-web-access",
      { source: "github:example/custom-extension", extensions: [] },
    ]);
  });

  it("never installs the retired plugin creator or overwrites a user's same-named skill", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    directories.push(agentDir);
    const skill = path.join(agentDir, "skills", "plugin-creator", "SKILL.md");
    await ensureOhMyGamePiEnvironment(agentDir);
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, "My own workflow");
    await ensureOhMyGamePiEnvironment(agentDir);
    expect(await readFile(skill, "utf8")).toBe("My own workflow");
    await expect(readFile(path.join(agentDir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
