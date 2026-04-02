# Remove sqlite-bindings.ts

The `packages/core/src/sqlite-bindings.ts` file provides SQLite database access inside the VM by proxying to host-side Node.js SQLite. It has pre-existing type errors and the approach (temp files synced between host and VM) is fragile.

Consider replacing with a proper in-VM SQLite implementation or removing if no longer needed.
