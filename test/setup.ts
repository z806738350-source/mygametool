import { inject } from "vitest";
import "./provider-environment.js";

process.env.TMPDIR = process.env.TEMP = process.env.TMP = inject("testTempDirectory");
