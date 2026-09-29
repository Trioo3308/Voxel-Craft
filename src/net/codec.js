/**
 * codec.js — Turning game state into messages and back.
 *
 * Messages are JSON. The one awkward thing to send is a save (the host hands
 * each guest its world when they join, see session.js): block edits are typed
 * arrays, which JSON would widen into huge lists of numbers, so they travel as
 * base64 of their raw bytes instead — about a third bigger than binary, and a
 * tenth the size of the JSON list.
 */

import { BLOCKS, ITEMS } from '../world/blocks.js';

/** Bytes to base64, in slices so a large array cannot overflow the call stack. */
export function bytesToBase64(bytes) {
  let binary = '';
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `{ [dimension]: [{ key, indices: Uint32Array, ids: Uint8Array }] }` as JSON-safe text. */
export function encodeEdits(edits) {
  const out = {};
  for (const [dimension, chunks] of Object.entries(edits ?? {})) {
    out[dimension] = chunks.map((chunk) => ({
      key: chunk.key,
      indices: bytesToBase64(new Uint8Array(chunk.indices.buffer, chunk.indices.byteOffset, chunk.indices.byteLength)),
      ids: bytesToBase64(chunk.ids),
    }));
  }
  return out;
}

export function decodeEdits(encoded) {
  const out = {};
  for (const [dimension, chunks] of Object.entries(encoded ?? {})) {
    out[dimension] = chunks.map((chunk) => {
      const raw = base64ToBytes(chunk.indices);
      return {
        key: chunk.key,
        indices: new Uint32Array(raw.buffer, 0, raw.byteLength >> 2),
        ids: base64ToBytes(chunk.ids),
      };
    });
  }
  return out;
}

/**
 * A block entity as it travels: its type and state, nothing transient (the
 * furnace's lit flag is worked out again wherever it lands).
 */
export function encodeEntity(entity) {
  if (!entity) return null;
  return { type: entity.type, state: entity.state };
}

/** A fresh entity from the wire, deep-copied so nothing shares a reference with the message. */
export function decodeEntity(data) {
  if (!data || typeof data.type !== 'string' || !data.state) return null;
  return { type: data.type, state: JSON.parse(JSON.stringify(data.state)), wasLit: false };
}

/**
 * A short fingerprint of this build's block and item registry. Ids travel as
 * plain numbers, so two builds that number things differently must not play
 * together; comparing this on join catches a stale cached page.
 */
export function registryFingerprint() {
  const names = [];
  for (const block of BLOCKS) if (block) names.push(`${block.id}:${block.name}`);
  for (const item of ITEMS) if (item) names.push(`${item.id}:${item.name}`);
  const text = names.join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
