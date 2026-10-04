const { contextBridge } = require('electron');

// Test control, registered on the fixture session so it runs before the app's preload captures
// the native speaker methods: slow down the speaker changes that reach Chromium, as a slow audio
// device would, make players reject them, hold them for one target until released, and record
// each one with its target.
contextBridge.executeInMainWorld({
  func: () => {
    /** @typedef {{id: unknown, release(): void}} Held */
    const page = /** @type {Window & {sinkDelay: number, sinkFail: boolean, sinkCalls: {target: unknown, id: unknown}[], sinkGates: Map<unknown, Held[]>, delaySinks(ms: number): void, gateSinks(target: unknown): void, heldSinks(target: unknown): unknown[], releaseSinks(): number}} */ (/** @type {unknown} */ (window));
    page.sinkDelay = 0; page.sinkFail = false; page.sinkCalls = []; page.sinkGates = new Map();
    page.delaySinks = ms => { page.sinkDelay = ms; };
    // Changes for a gated target enter the hook and wait there until releaseSinks().
    page.gateSinks = target => { if (!page.sinkGates.has(target)) page.sinkGates.set(target, []); };
    page.heldSinks = target => (page.sinkGates.get(target) ?? []).map(held => held.id);
    page.releaseSinks = () => {
      const held = [...page.sinkGates.values()].flat();
      page.sinkGates.clear();
      for (const entry of held) entry.release();
      return held.length;
    };
    for (const proto of /** @type {{setSinkId(id: unknown): Promise<void>}[]} */ (/** @type {unknown[]} */ ([HTMLMediaElement.prototype, AudioContext.prototype]))) {
      const original = proto.setSinkId;
      /** @this {unknown} @param {unknown} id */
      proto.setSinkId = function setSinkId(id) {
        page.sinkCalls.push({ target: this, id });
        const gate = page.sinkGates.get(this);
        const entered = gate ? new Promise(resolve => gate.push({ id, release: () => resolve(undefined) })) : null;
        const proceed = () => {
          const fail = page.sinkFail && this instanceof HTMLMediaElement;
          if (!page.sinkDelay && !fail) return original.call(this, id);
          return new Promise(resolve => setTimeout(resolve, page.sinkDelay)).then(() => fail ? Promise.reject(new DOMException('Test speaker failure.', 'AbortError')) : original.call(this, id));
        };
        return entered ? entered.then(proceed) : proceed();
      };
    }
  },
});
