/**
 * workerEntry.js — Starts the world worker without losing messages.
 *
 * The worker's modules finish loading asynchronously: blocks.js waits for the
 * content packs with top-level await. Until worker.js has run, nothing listens
 * for messages, and a message dispatched with no listener is simply gone. The
 * first one every world sends is 'init', so losing it left the loading screen
 * waiting forever. This holds messages until the worker is ready, then hands
 * them over in the order they arrived.
 */

const early = [];
self.onmessage = (event) => early.push(event);

await import('./worker.js');

// worker.js has installed its own handler by now.
for (const event of early) self.onmessage(event);
