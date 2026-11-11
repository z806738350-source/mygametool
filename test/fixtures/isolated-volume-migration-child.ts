// Ordinary synthetic files only. No ext4, VM, application, account or network.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  IsolatedVolumeMigrationStore,
  mintNativeVolumeMigrationAuthorization,
  type VolumeMigrationRegistry,
} from "../../src/daemon/isolated-volume-migration.js";

const directory = process.argv[2]!,
  mode = process.argv[3] ?? "success";
const registry = JSON.parse(
    readFileSync(path.join(directory, "registry.json"), "utf8"),
  ) as VolumeMigrationRegistry,
  source = registry.volumes[0]!;
const store = new IsolatedVolumeMigrationStore({
  directory,
  runtime: { kind: "local-fixture", supported: true },
});
let held = false;
let migrationId: string | undefined;
const signal = {
  aborted: false,
  throwIfAborted() {
    if (
      mode === "hold" &&
      !held &&
      existsSync(path.join(directory, "mutation-lease.json"))
    ) {
      held = true;
      process.stdout.write(JSON.stringify({ event: "lease-held" }) + "\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
    if (
      mode === "crash" &&
      JSON.parse(readFileSync(path.join(directory, "registry.json"), "utf8"))
        .volumes[0].imageId !== source.imageId
    )
      process.exit(42);
    if (mode === "pre-switch-crash" && migrationId) {
      const file = path.join(
        directory,
        "migrations",
        migrationId,
        "intent.json",
      );
      if (
        existsSync(file) &&
        JSON.parse(readFileSync(file, "utf8")).phase === "switch-submitting"
      )
        process.exit(43);
    }
  },
} as AbortSignal;
try {
  const plan = await store.prepare(
    {
      namespace: source.namespace,
      projectId: source.projectId,
      targetProfileId: "capacity-128-v1",
      expectedGeneration: source.generation,
      expectedSourceSha256: source.sha256,
    },
    signal,
  );
  process.stdout.write(JSON.stringify({ id: plan.id }) + "\n");
  migrationId = plan.id;
  const grant = await mintNativeVolumeMigrationAuthorization(store, plan);
  process.stdout.write(
    JSON.stringify(await store.start(plan, grant, signal)) + "\n",
  );
} catch (cause) {
  const code = (cause as { code?: string }).code;
  process.stdout.write(JSON.stringify({ error: code ?? "UNKNOWN" }) + "\n");
  process.exit(code === "VOLUME_MIGRATION_MUTATION_LEASE" ? 75 : 76);
}
