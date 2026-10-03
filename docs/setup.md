# Setup

The guest runs on Linux with `/dev/kvm`. A Mac can run the unit tests and the recorded page. It cannot boot Firecracker.

A small Intel or AMD instance with nested virtualization is enough. Ubuntu 24.04 is the host used here. Firecracker 1.16.1 was tested by upstream on host kernels 5.10, 6.1, and 6.18. Enable nested virtualization when the instance is launched. Give the root disk at least 20 GB. The guest root filesystem is about 1 GB, and a move copies it.

```bash
make setup
make test
make demo
make local-up
```

`make local-up` listens on 127.0.0.1. Tunnel that port over SSH and open the printed URL.

`make setup` downloads Firecracker 1.16.1, a 6.1 guest kernel, and an Ubuntu 24.04 root filesystem, then copies `guest/` into the image. Run it again after changing the guest programs.

VM A, VM B, and VM C are three network namespaces on this one machine. The guest address is always `172.16.0.2`. The page reaches it through a veth in front of the namespace.
