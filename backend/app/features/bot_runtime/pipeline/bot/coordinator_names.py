"""Canonical names for the built-in collaboration assistant."""

COORDINATOR_USERNAMES = ("Coordinator", "Helper", "channel bot", "coordinator")


def is_coordinator_username(username: str | None) -> bool:
    return bool(username) and username in COORDINATOR_USERNAMES


def first_coordinator_username(usernames: list[str]) -> str | None:
    for candidate in COORDINATOR_USERNAMES:
        if candidate in usernames:
            return candidate
    return None
