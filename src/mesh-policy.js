// A Market credential is bound by digest, never stored in a grant or receipt.
export function validMeshScope(s) {
  return !!s && /^[a-f0-9]{64}$/.test(s.key_sha256) && Array.isArray(s.capabilities) &&
    s.capabilities.length > 0 && s.capabilities.length <= 20 &&
    s.capabilities.every(c => typeof c === 'string' && /^[a-z0-9-]{1,80}$/.test(c)) &&
    Number.isSafeInteger(s.max_mesh_per_call) && s.max_mesh_per_call >= 0;
}
export function meshScopeViolation(parent, child) {
  if (!validMeshScope(child)) return 'mesh_scope_required';
  if (!parent) return null; // Only a tenant root may introduce the first scope (policy.js).
  if (!validMeshScope(parent) || child.key_sha256 !== parent.key_sha256 ||
    child.max_mesh_per_call > parent.max_mesh_per_call ||
    !child.capabilities.every(c => parent.capabilities.includes(c))) return 'mesh_scope_widened';
  return null;
}
