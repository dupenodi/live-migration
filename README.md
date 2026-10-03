# Live migration

A Firecracker microVM moves from one worker to another while a client keeps one stream open. The process inside keeps the same boot id, pid, and counter. The pause is measured.

VM A, VM B, and VM C are network namespaces on one Linux machine. Each has its own Firecracker process, disk, API socket, and network. The guest address stays `172.16.0.2`. The page talks to a proxy, and the proxy is the address that does not change.

## Run

On a Linux host with `/dev/kvm`:

```bash
make setup      # Firecracker 1.16.1, guest kernel, root disk
make test       # unit tests, a real boot, and the failure cases
make demo       # move VM A to VM B and write demo/last-report.json
make local-up   # boot VM A and serve the page on 127.0.0.1
```

`make local-up` prints a port. From a laptop:

```bash
ssh -L 8080:127.0.0.1:PORT user@host
```

Open `http://127.0.0.1:8080/`.

On a Mac, `npm test` runs the tests that do not need KVM. `npm run page` plays a recorded move in the browser. Firecracker itself needs Linux.

Host notes are in [docs/setup.md](docs/setup.md). The move itself is in [docs/design.md](docs/design.md).

## What you see

The page shows the guest log, one line a second. Click a worker and the same log continues there. After the move it shows total time, how long the VM was paused, the longest gap between lines, the bytes copied, and whether boot id, pid, and the counter stayed continuous.

`make demo` writes the same numbers to `demo/last-report.json`.

## API

```text
POST /v1/sandboxes
PUT  /v1/sandboxes/:id/files
POST /v1/sandboxes/:id/commands
POST /v1/sandboxes/:id/ports
POST /v1/sandboxes/:id/migrations
GET  /v1/sandboxes/:id/migrations/:move
GET  /v1/sandboxes/:id
```

The TypeScript client is `src/sdk/client.ts`. A repeated migration key returns the same move. The same key with a different destination is rejected. If the copy or the restore fails, the destination is discarded and the source resumes. The source is stopped only after the destination answers `/health`.

## What this still needs

This is a full snapshot. The VM is paused, the memory, CPU state, and disk are copied, and a new process loads them. That is simple and it recovers. It is not how this should run for customers.

- Copy dirty pages while the source keeps running, so a move does not freeze the guest for the whole transfer.
- Checksum the memory file and refuse to start a copy that does not match.
- Fence with a lease. If the migrator dies, the source resumes instead of staying paused.
- Encrypt the snapshot on the wire and on disk. It is the guest's memory.
- Check the destination CPU and Firecracker version before the copy starts.
- Make cutover one switch: point the proxy, stop the source, and roll back if the new copy misses a health check.
- Store migration state outside the process. A restart currently forgets which copy is live.
- Quiesce the guest disk before the snapshot.
- Export pause, gap, bytes, and failures as metrics.
- Authenticate the API and the guest agent.
- Cap concurrent moves and bandwidth.

## Where I would work

The page is the part I would keep owning: the first demo through to a product UI. I have not shipped mobile. I would learn that from the mobile team and take real app work. I already use the product as a customer and turn the confusing parts into fixes. I have done client-facing work before, from the problem through to something that runs.

The gap is the system under the page. I built this demo quickly. I would learn the VM and migration path properly, then harden it: observability, failure handling, and performance. I would rather be able to say why a move is safe than only how to start one.
