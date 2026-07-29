/**
 * whoami.mjs — Show the link to send other players, and diagnose why it might
 * not be working.
 *
 *   npm run whoami
 *
 * Probes for a running server rather than assuming a port, so the address it
 * prints is the one that actually works.
 */

import net from 'node:net';
import os from 'node:os';

/** Ports worth checking: the project default, then common fallbacks. */
const CANDIDATES = [5173, 5174, 3000, 8080, 8000];

function isListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(300);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Is the server reachable over the LAN address, not just loopback?
 * A server bound only to 127.0.0.1 answers on localhost but is invisible to
 * everyone else — this catches exactly that case.
 */
function isReachableAt(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, host);
  });
}

function lanAddresses() {
  const found = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      // Virtual adapters (WSL, Docker, Hyper-V) are not reachable from a LAN peer.
      if (/^(vEthernet|WSL|Docker|VirtualBox|VMware|Loopback|Hyper-V)/i.test(name)) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local, no DHCP
      found.push({ name, address: info.address });
    }
  }
  return found;
}

const running = [];
for (const port of CANDIDATES) {
  if (await isListening(port)) running.push(port);
}

const addresses = lanAddresses();

console.log('\n  Voxel Craft — sharing check\n');

if (addresses.length === 0) {
  console.log('  No network address found. Connect to Wi-Fi or Ethernet first.\n');
  process.exit(0);
}

if (running.length === 0) {
  console.log('  No server is running. Start one with:\n');
  console.log('    npm run host\n');
  console.log('  Then run this again to get the link.\n');
  process.exit(0);
}

const port = running[0];
console.log(`  Server found on port ${port}.\n`);

let anyReachable = false;
console.log('  SEND THIS to other players:');
for (const { name, address } of addresses) {
  const reachable = await isReachableAt(address, port);
  if (reachable) anyReachable = true;
  console.log(`    http://${address}:${port}   [${name}] ${reachable ? '' : '  <-- NOT reachable'}`);
}

console.log(`
  For yourself only:
    http://localhost:${port}

  A "localhost" link will NEVER work for anyone else — on their machine
  localhost means their own computer.
`);

if (!anyReachable) {
  console.log(`  Problem: the server is not accepting connections on your network
  address, only on localhost. Restart it with:

    npm run host

  which binds to all interfaces.
`);
} else {
  console.log(`  If a player still gets a timeout, Windows Firewall is blocking it.
  In an Administrator PowerShell, run once:

    New-NetFirewallRule -DisplayName "Voxel Craft ${port}" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow -Profile Private

  Also check you are both on the same network (not one on Wi-Fi and one on a
  guest network or a phone hotspot).
`);
}

if (running.length > 1) {
  console.log(`  Note: servers are also running on ports ${running.slice(1).join(', ')}. ` +
    'Make sure you share the right one.\n');
}
