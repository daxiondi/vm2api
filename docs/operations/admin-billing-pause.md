# Pause management billing reads

This temporary control skips historical management billing calculations while
keeping request handling, usage/cost writes, account quotas, and scheduling active.
It does not delete or reset billing records.

Create `data/admin-billing-paused` to pause the six financial read wrappers in
`RequestLogStore`. Removing the file restores them on the same store instance.
The frontend supports `globalThis.__VM2API_ADMIN_BILLING_PAUSED__ = true` before
the application bundle starts: it shows a pause notice, replaces aggregate dollar
amounts with an em dash, and does not mount the dedicated billing query page.
Individual request logs retain their real recorded costs.

For a process started before this guard was installed,
`scripts/admin-billing-live-pause.mjs apply /opt/vm2api` applies the same file
guard to its already loaded class. This is an emergency runtime operation:

1. Back up the exact live module, frontend directory, and Compose override.
2. Stage the tested module and frontend, keeping the old asset files available
   for browsers with an older index. Activate the pause file.
3. Enable the target Node process inspector on loopback only. Run the helper
   inside the same container. It checks the target entry, saves original method
   descriptors, changes only the six read wrappers, and closes the inspector.
4. Persist the tested module and frontend as scoped read-only mounts if the
   container is later recreated. Do not restart or recreate it to enable pause.
5. Verify the UI, production completion records and cost writes, quota freshness,
   health latency, process start time, and OOM counters. Memory need not fall
   immediately; in-flight queries and allocator caches are not forcibly cleared.

Rollback removes the pause file and restores the original frontend index.
The live helper's `restore` mode also reinstates the original descriptors if
required. Restore the backed-up module and Compose override to remove the patch
entirely. Never delete historical billing data, force garbage collection, pause
the debugger, or restart production solely to make the memory chart fall.
