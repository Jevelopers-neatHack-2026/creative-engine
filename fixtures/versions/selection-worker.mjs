import { CreativeVersionStore } from "../../src/versions/store.mjs";

const input = JSON.parse(process.env.CREATIVE_VERSION_SELECTION_INPUT ?? "null");
if (!input || typeof input.databasePath !== "string" || typeof input.objectRoot !== "string" || !input.selection) {
  process.exit(2);
}
const store = new CreativeVersionStore({ databasePath: input.databasePath, objectRoot: input.objectRoot });
process.send?.({ type: "ready" });
process.on("message", async (message) => {
  if (message?.type !== "start") return;
  try {
    const result = await store.selectDesignVersion(input.selection);
    process.send?.({ type: "result", result });
    store.close();
    process.disconnect?.();
  } catch (error) {
    process.send?.({ type: "error", code: typeof error?.code === "string" ? error.code : "unavailable" });
    store.close();
    process.disconnect?.();
  }
});
