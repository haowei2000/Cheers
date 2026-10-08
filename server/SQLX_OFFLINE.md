# SQLx offline builds

The gateway uses SQLx 0.8.6 query macros for selected static queries. Commit
`server/.sqlx/query-*.json` with any query or schema change. These files describe
queries, parameter types, result types, and nullability; they contain no database
credentials. Existing SQL migrations remain the schema authority.

## Ordinary builds

Cargo configuration at the repository root and in `server/.cargo/` defaults
`SQLX_OFFLINE=true`, covering both repository scripts and commands run in
`server/`. Docker explicitly sets the same variable and copies `server/.sqlx`.
Builds need no database connection, even if `DATABASE_URL` is present. Integration
tests still require `DATABASE_URL` at runtime.

```bash
cd server
cargo build
cargo test
```

## Refresh metadata from an empty database

Install the matching CLI once:

```bash
cargo install sqlx-cli --version 0.8.6 --locked --no-default-features --features postgres,rustls
```

From the repository root, start a disposable PostgreSQL 16 container without
mounting a data volume. Read the assigned port instead of assuming one:

```bash
docker run -d --name cheers-sqlx-prepare \
  -e POSTGRES_USER=cheers -e POSTGRES_PASSWORD=cheers -e POSTGRES_DB=cheers_sqlx \
  -p 127.0.0.1::5432 postgres:16-alpine
docker exec cheers-sqlx-prepare pg_isready -U cheers
# Wait until pg_isready succeeds before continuing.
sqlx_port="$(docker port cheers-sqlx-prepare 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgres://cheers:cheers@127.0.0.1:${sqlx_port}/cheers_sqlx"
bash scripts/sqlx-offline.sh prepare
bash scripts/sqlx-offline.sh check
docker rm -f cheers-sqlx-prepare
unset DATABASE_URL
```

The script applies every migration and explicitly sets `SQLX_OFFLINE=false`
while preparing. Use only a disposable database: it applies migrations to the
supplied URL. Do not edit already-applied migrations to make a query compile.
Review and commit the source changes and generated `.sqlx` files together.

## CI and gradual adoption

Gateway Integration starts a fresh Postgres service, installs the pinned CLI,
and runs `scripts/sqlx-offline.sh check` before tests and Clippy. Missing, stale,
or unused query metadata fails the check. Tests and Clippy compile offline.

Prefer `query!`, `query_as!`, or `query_scalar!` for new or modified static SQL,
especially message writes, task reservations, authentication, and permissions.
Keep runtime queries or `QueryBuilder` for dynamic SQL. Explicit nullability
annotations must follow SQL semantics: `EXISTS` always returns a boolean, while
nullable columns such as `thread_root_msg_id` must remain `Option` values.
Macros do not verify authorization logic, isolation, or locking; existing
behavior and concurrency tests remain necessary.
