// Kernel service container: a name → instance registry and nothing more.
// Re-registration intentionally overwrites silently — the kernel has no basis
// to reject or log it; lifecycle/ownership semantics belong to the callers.
export function createServices() {
  const reg = new Map();
  return {
    register(name, obj) { reg.set(name, obj); },
    get(name) { return reg.get(name); }, // unknown name → undefined: "not provided", not an error
  };
}
