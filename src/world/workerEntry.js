/**
 * workerEntry.js — Starts a world worker without losing messages.
 *
 * The workers' modules finish loading asynchronously: blocks.js waits for the
 * content packs with top-level await. Until the worker module has run, nothing
 * listens for messages, and a message dispatched with no listener is simply
 * gone. The first one every world sends is 'init', so losing it left the
 * loading screen waiting forever. This holds messages until the worker is
 * ready, then hands them over in the order they arrived.
 *
 * `workerEntry.js` starts the chunk worker; `workerEntry.js?far` starts the
 * distant-terrain worker (farWorker.js).
 */

const early = [];
self.onmessage = (event) => early.push(event);

const far = new URL(self.location.href).searchParams.has('far');
await import(far ? './farWorker.js' : './worker.js');

// The worker has installed its own handler by now.
for (const event of early) self.onmessage(event);
