import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OHMYGAME_QODER_FIXTURE_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error("Missing isolated SDK fixture root");
delete process.env.OHMYGAME_QODER_FIXTURE_ROOT;
const fake = path.join(root, "fake-cli.mjs");
const record = (value) =>
  appendFileSync(path.join(root, "guard.jsonl"), JSON.stringify(value) + "\n");
const deny = (kind) => () => {
  record({ denied: kind });
  throw new Error(
    "Networking and unrelated processes are disabled in the SDK fixture",
  );
};
net.Socket.prototype.connect = deny("net.connect");
net.Server.prototype.listen = deny("net.listen");
tls.connect = deny("tls.connect");
http2.connect = deny("http2.connect");
dgram.createSocket = deny("dgram.createSocket");
for (const name of ["send", "connect", "bind"])
  dgram.Socket.prototype[name] = deny("dgram." + name);
workerThreads.Worker = class {
  constructor() {
    deny("worker_threads.Worker")();
  }
};
for (const module of [http, https]) {
  module.request = deny("http.request");
  module.get = deny("http.get");
}
for (const [kind, module] of [
  ["dns", dns],
  ["dns.promises", dns.promises],
]) {
  for (const name of Object.keys(module).filter((name) =>
    /^(?:lookup|resolve|reverse)/.test(name),
  ))
    module[name] = deny(kind + "." + name);
  module.Resolver = class {
    constructor() {
      deny(kind + ".Resolver")();
    }
  };
}
globalThis.fetch = deny("fetch");
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (
    command !== process.execPath ||
    !Array.isArray(args) ||
    args.length !== 2 ||
    args[0] !== fake ||
    args[1] !== "--sdk" ||
    options?.env?.HOME !== path.join(root, "qoder", "home") ||
    options?.env?.QODER_CONFIG_DIR !== path.join(root, "qoder", "config")
  )
    return deny("process.spawn")();
  const child = spawn(
    command,
    ["--import", fileURLToPath(import.meta.url), ...args],
    {
      ...options,
      env: { ...options.env, OHMYGAME_QODER_FIXTURE_ROOT: root },
    },
  );
  record({ spawned: "local-fake-cli", args, pid: child.pid });
  return child;
};
for (const name of [
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
])
  childProcess[name] = deny("process." + name);
syncBuiltinESMExports();
