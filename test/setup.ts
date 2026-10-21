import { mkdirSync } from "node:fs";
import path from "node:path";
// Keep native-tool scratch files under the writable checkout on restricted
// Windows hosts; this is also a predictable location for CI cleanup.
const scratch = path.resolve(".test-tmp");
mkdirSync(scratch, { recursive: true });
process.env.TEMP = scratch; process.env.TMP = scratch; process.env.TMPDIR = scratch;
