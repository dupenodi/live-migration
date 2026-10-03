const vms = {
  "worker-a": { label: "VM A", tone: "a" },
  "worker-b": { label: "VM B", tone: "b" },
  "worker-c": { label: "VM C", tone: "c" },
}

export function vmChip(vm) {
  const { label, tone } = vms[vm] ?? { label: vm, tone: "unknown" }
  const chip = document.createElement("span")
  chip.className = `chip chip-${tone}`
  const dot = document.createElement("span")
  dot.className = "chip-dot"
  dot.setAttribute("aria-hidden", "true")
  chip.append(dot, label)
  return chip
}
