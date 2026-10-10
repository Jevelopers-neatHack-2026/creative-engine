import { readFile, writeFile } from "node:fs/promises";

/** TEST ONLY: file-backed fixture for observation replay; it has no billing logic. */
export class JsonObservationOutboxFixture {
  constructor(path, { failNextAcknowledge = false } = {}) {
    this.path = path;
    this.failNextAcknowledge = failNextAcknowledge;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { records: [] };
      throw error;
    }
  }

  async #write(state) {
    await writeFile(this.path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async enqueue(record) {
    const state = await this.#read();
    if (state.records.some((item) => item.record_ref === record.record_ref)) return;
    state.records.push({ status: "pending", ...structuredClone(record) });
    await this.#write(state);
  }

  async claimPending({ limit }) {
    const state = await this.#read();
    return {
      status: "claimed",
      records: state.records.filter((record) => record.status === "pending").slice(0, limit)
        .map(({ status: _status, ...record }) => structuredClone(record)),
    };
  }

  async acknowledge({ record_ref, source_observation_id }) {
    if (this.failNextAcknowledge) {
      this.failNextAcknowledge = false;
      throw new Error("fixture simulates loss after external observation acknowledgement");
    }
    const state = await this.#read();
    const record = state.records.find((item) => item.record_ref === record_ref);
    if (!record || record.observation.source_observation_id !== source_observation_id) {
      return { status: "mismatch", source_observation_id };
    }
    record.status = "delivered";
    await this.#write(state);
    return { status: "acknowledged", source_observation_id };
  }

  async defer({ record_ref, reason }) {
    const state = await this.#read();
    const record = state.records.find((item) => item.record_ref === record_ref);
    if (record?.status === "pending") record.last_retry_reason = reason;
    await this.#write(state);
    return { status: "retained" };
  }

  async status(recordRef) {
    const state = await this.#read();
    return state.records.find((item) => item.record_ref === recordRef)?.status;
  }
}
