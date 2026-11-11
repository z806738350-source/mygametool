/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { build as buildWithEsbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import { parseChangelog } from "./src/shared/changelog.js";
import { DAEMON_RUNTIME_FILE, readLocalDaemonRuntime } from "./src/daemon/runtime-descriptor.js";
import { isAllowedLocalOrigin, isLoopbackHostHeader } from "./src/shared/local-security.js";
import { forwardLocalDaemonRequest } from "./src/daemon/local-development-proxy.js";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export default defineConfig({
  // The local launcher sends an explicit .env path only to the daemon.
  envDir: false,
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_CHANGELOG__: JSON.stringify(parseChangelog(readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8"))),
  },
  plugins: [
    authenticatedLocalDevelopment(),
    playableSandboxDevPlugin(),
    react(),
  ],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        webGameHost: path.resolve(import.meta.dirname, "web-game-host.html"),
        playableSandbox: path.resolve(import.meta.dirname, "playable-sandbox.html"),
      },
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    globalSetup: ["test/temp-directory.ts"],
    setupFiles: ["test/setup.ts"],
    // Real compiler builds and grammar initialization need bounded parallelism on Bun.
    maxWorkers: 4,
    // Playable build tests run real esbuild/vite builds and exceed the 5s default under parallel load.
    testTimeout: 30_000,
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    strictPort: true,
    fs: { deny: [".env", ".env.*", "**/.git/**", "**/.data/**", "**/daemon-runtime.json", "**/*.{crt,pem}"] },
    watch: { ignored: ["**/.data/**", "**/dist/**"] },
  },
});

function authenticatedLocalDevelopment(): Plugin {
  return {
    name: "authenticated-local-development",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try { pathname = decodeURIComponent((request.url ?? "").split("?")[0]!); }
        catch { response.writeHead(400).end("Invalid path"); return; }
        if (pathname.split(/[\\/]/).includes(DAEMON_RUNTIME_FILE)) {
          response.writeHead(403).end("Private runtime file"); return;
        }
        if (!isLoopbackHostHeader(request.headers.host) || !isAllowedLocalOrigin(request.headers.origin, request.headers.host)) {
          response.writeHead(403).end("Local origin required"); return;
        }
        if (pathname === "/api" || pathname.startsWith("/api/")) {
          if (request.headers["x-ohmygame-dev-client"] !== "1") {
            response.writeHead(403).end("Application request required"); return;
          }
          try {
            const directory = process.env.OHMYGAME_DATA_DIR ?? path.join(import.meta.dirname, ".data");
            forwardLocalDaemonRequest(request, response, readLocalDaemonRuntime(path.join(directory, DAEMON_RUNTIME_FILE)));
          } catch { response.writeHead(502).end("The authenticated local daemon is unavailable"); }
          return;
        }
        next();
      });
      server.httpServer?.prependListener("upgrade", (request, socket) => {
        if (!isLoopbackHostHeader(request.headers.host) || request.headers.origin !== `http://${request.headers.host}` || (request.url ?? "").startsWith("/api")) socket.destroy();
      });
    },
  };
}

function playableSandboxDevPlugin(): Plugin {
  const html = readFileSync(
    new URL("./playable-sandbox.html", import.meta.url),
    "utf8",
  );
  const entry = path.resolve(
    import.meta.dirname,
    "src/renderer/playable-sandbox-entry.ts",
  );
  return {
    name: "playable-sandbox-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(
          request.url ?? "/",
          "http://localhost",
        ).pathname;
        if (pathname === "/playable-sandbox.html") {
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
          return;
        }
        if (pathname !== "/assets/playable-sandbox.js") {
          next();
          return;
        }
        try {
          const result = await buildWithEsbuild({
            entryPoints: [entry],
            bundle: true,
            charset: "utf8",
            format: "iife",
            platform: "browser",
            sourcemap: "inline",
            target: "es2022",
            write: false,
          });
          const javascript = result.outputFiles[0]?.text;
          if (!javascript) throw new Error("Sandbox build produced no output.");
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader(
            "Content-Type",
            "text/javascript; charset=utf-8",
          );
          response.end(javascript);
        } catch (cause) {
          server.config.logger.error(
            cause instanceof Error ? cause.message : String(cause),
          );
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Playable sandbox could not be built.");
        }
      });
    },
  };
}
