.PHONY: lint fix

lint:
	cd backend && uv run ruff check app/

fix:
	cd backend && uv run ruff check --fix app/
