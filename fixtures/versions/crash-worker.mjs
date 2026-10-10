import { Buffer } from "node:buffer";
import { CreativeVersionStore } from "../../src/versions/store.mjs";

const input = JSON.parse(process.env.CREATIVE_VERSION_WRITE_JSON);
const write = {
  ...input,
  artifact_bytes: Buffer.from(input.artifact_bytes_base64, "base64"),
};
delete write.artifact_bytes_base64;

const store = new CreativeVersionStore({
  databasePath: process.env.CREATIVE_VERSION_DATABASE,
  objectRoot: process.env.CREATIVE_VERSION_OBJECTS,
  now: () => Date.parse("2026-10-10T12:30:00.000Z"),
});

await store.saveDesignVersion(write, {
  faultInjector(point) {
    if (point === process.env.CREATIVE_VERSION_CRASH_AT) process.exit(86);
  },
});
store.close();
