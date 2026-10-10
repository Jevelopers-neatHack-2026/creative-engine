import { parentPort, workerData } from 'node:worker_threads';
import { ApplyStore } from '../../src/controls/actions.mjs';
import { action, fixtureState, principal, projection } from '../../fixtures/controls/state.mjs';
const state = fixtureState();
const store = new ApplyStore(workerData.path, () => projection(state));
parentPort.postMessage(store.apply(principal, action(state)));
store.close();
