set positional-arguments := true

release *args:
	npx tsx scripts/release.ts "$@"

dev-shell *args:
	pnpm --filter @rivet-dev/agent-os-dev-shell dev-shell -- "$@"
