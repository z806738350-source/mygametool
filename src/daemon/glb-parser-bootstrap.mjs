// Development-only worker entry. Production uses the compiled .js worker directly.
import { register } from "tsx/esm/api";
register();
await import("./glb-parser-worker.ts");
