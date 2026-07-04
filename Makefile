.PHONY: lint fix test docs-pages

lint:
	cd server && cargo clippy --all-targets

fix:
	cd server && cargo fmt && cargo clippy --fix --allow-dirty --allow-staged

test:
	cd server && cargo test

docs-pages:
	node scripts/generate-architecture-status-page.mjs
