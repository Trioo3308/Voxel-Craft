/**
 * whoami.mjs — Print the URLs other people on your network can use.
 *
 * Run with:  npm run whoami
 */

import os from 'node:os';

const PORT = 5173;

const addresses = [];
for (const [name, infos] of Object.entries(os.networkInterfaces())) {
  for (const info of infos ?? []) {
    if (info.family !== 'IPv4' || info.internal) continue;
    // Skip virtual adapters (WSL, Docker, Hyper-V) — those are not reachable
    // from other machines on the LAN.
    if (/^(vEthernet|WSL|Docker|VirtualBox|VMware|Loopback)/i.test(name)) continue;
    if (info.address.startsWith('169.254.')) continue; // link-local, no DHCP
    addresses.push({ name, address: info.address });
  }
}

console.log('\n  Voxel Craft — share these with your players\n');
console.log(`  You:          http://localhost:${PORT}`);

if (addresses.length === 0) {
  console.log('\n  No LAN address found. Are you connected to Wi-Fi or Ethernet?');
} else {
  for (const { name, address } of addresses) {
    console.log(`  On ${name}:   http://${address}:${PORT}`);
  }
}

console.log(`
  Start the shareable server with:   npm run host

  Everyone must be on the SAME Wi-Fi / network.

  If they cannot connect, Windows Firewall is almost certainly blocking it.
  Open PowerShell **as Administrator** once and run:

    New-NetFirewallRule -DisplayName "Voxel Craft ${PORT}" -Direction Inbound -LocalPort ${PORT} -Protocol TCP -Action Allow -Profile Private

  (Profile Private keeps it to trusted networks — not coffee-shop Wi-Fi.)
  To remove it later:

    Remove-NetFirewallRule -DisplayName "Voxel Craft ${PORT}"
`);
