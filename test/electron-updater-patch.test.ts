import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("does not ship a remote updater, telemetry SDKs or an author update feed", async () => {
  const metadata = JSON.parse(await readFile("package.json", "utf8"));
  const dependencies = { ...metadata.dependencies, ...metadata.devDependencies };
  for (const name of ["electron-updater", "@sentry/electron", "@sentry/vite-plugin", "posthog-js", "@supabase/supabase-js"]) expect(dependencies).not.toHaveProperty(name);
  expect(metadata.patchedDependencies).not.toHaveProperty("electron-updater@6.8.9");
  const config = parse(await readFile("electron-builder.yml", "utf8"));
  expect(config.publish).toBeNull();
  expect(JSON.stringify(config.extraResources)).not.toMatch(/preinstalled-plugins|examples|desktop-config/);
  for (const name of ["build:desktop-app", "dev:daemon", "dev:desktop", "start:desktop"]) expect(metadata.scripts[name]).not.toMatch(/prepare:(?:examples|preinstalled-plugins)/);
});

it("leaves remote resource preparation explicitly unavailable", async () => {
  for (const name of ["prepare-examples.ts", "prepare-preinstalled-plugins.ts"]) {
    const source = await readFile(`scripts/${name}`, "utf8");
    expect(source).toMatch(/^throw new Error/);
    expect(source).toContain("disabled in this local-only build");
    expect(source).not.toMatch(/https?:|spawn|fetch|import /);
  }
});
