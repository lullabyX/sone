"""Process-local state for Sone's private helper entrypoint."""

_enabled = False


def enable() -> None:
    global _enabled
    _enabled = True


def is_enabled() -> bool:
    return _enabled
