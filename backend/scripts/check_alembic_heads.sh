#!/bin/sh
set -eu

check_heads() {
  config="$1"
  label="$2"

  heads="$(alembic -c "$config" heads)"
  count="$(printf '%s\n' "$heads" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [ "$count" != "1" ]; then
    echo "Expected exactly one Alembic head for ${label}, found ${count}." >&2
    alembic -c "$config" heads --verbose >&2
    exit 1
  fi

  echo "${label} Alembic head is unique:"
  printf '%s\n' "$heads"
}

check_heads "alembic.ini" "main DB"
check_heads "alembic_context.ini" "context store"
