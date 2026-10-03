# Design

One Firecracker process is the guest. The counter inside it keeps a single number. That number advances only when a line is delivered, so the client connection can be opened again after restore and the count continues. `boot_id` and `pid` come from the guest and stay the same because the guest is not rebooted.

A move pauses that process, writes a full snapshot (memory, VM state, and the writable disk), copies those three files to the destination namespace, and loads them in a new Firecracker process. The source stays paused until the destination answers `/health` with the same boot id, the same pid, and a counter that has not gone backwards. Then the proxy points at the destination and the source process is stopped. If the copy or the restore fails, the destination files are deleted and the source is resumed. Only one copy is running after that.

The page keeps one HTTP stream to the proxy. The proxy may open a new connection to the guest. The client does not.

Pause time, the longest gap, the byte count, and the continuity checks are on the page after a move. `make demo` writes the same report to `demo/last-report.json`.

## Three hosts later

VM A, VM B, and VM C would each sit on their own machine. Those machines need the same Firecracker version and a compatible CPU. The copy step sends the three files over the network instead of into another directory on this host. The proxy stays the address the client already has. The source is stopped only after the destination health check passes, same as here.
