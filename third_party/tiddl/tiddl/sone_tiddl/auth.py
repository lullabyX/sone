"""Authentication supplied by Sone over an inherited private socket."""

from __future__ import annotations

import json
import socket
from dataclasses import dataclass
from time import time
from typing import Any

class SoneAuthError(RuntimeError):
    pass


AUTH_FD = 3


@dataclass
class CredentialSnapshot:
    access_token: str
    refresh_token: str
    user_id: str
    country_code: str
    client_id: str
    client_secret: str
    expires_at: int = 0
    proxy_url: str | None = None

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "CredentialSnapshot":
        if message.get("type") != "credentials":
            raise SoneAuthError("missing credentials message")
        try:
            return cls(**message["credentials"])
        except (KeyError, TypeError) as error:
            raise SoneAuthError("invalid credentials message") from error

    def as_message(self) -> dict[str, Any]:
        return {"type": "credentials_refreshed", "credentials": self.__dict__}


class SoneAuthProvider:
    """Uses no files, environment secrets, or persistent HTTP cache."""

    def __init__(self, connection: socket.socket, credentials: CredentialSnapshot) -> None:
        self._connection = connection
        self._credentials = credentials

    @classmethod
    def from_inherited_socket(cls, fd: int = AUTH_FD) -> "SoneAuthProvider":
        connection: socket.socket | None = None
        try:
            inherited = socket.socket(fileno=fd)
            # Do not retain the inherited descriptor itself. The duplicated
            # connection remains private to this process and can return token
            # refreshes, while subprocesses cannot inherit descriptor 3.
            connection = inherited.dup()
            inherited.close()
            with connection.makefile("r", encoding="utf-8", newline="\n") as stream:
                message = json.loads(stream.readline())
            credentials = CredentialSnapshot.from_message(message)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            if connection is not None:
                connection.close()
            raise SoneAuthError("could not read Sone authentication") from error
        except SoneAuthError:
            if connection is not None:
                connection.close()
            raise
        return cls(connection, credentials)

    def create_api(self) -> TidalAPI:
        from tiddl.core.api import TidalAPI, TidalClient
        from tiddl.core.auth import AuthAPI
        from tiddl.core.auth.client import AuthClient

        proxies = {"https": self._credentials.proxy_url} if self._credentials.proxy_url else None
        auth_api = AuthAPI(AuthClient(
            self._credentials.client_id,
            self._credentials.client_secret,
            proxies,
        ))

        def refresh() -> str | None:
            response = auth_api.refresh_token(self._credentials.refresh_token)
            self._credentials.access_token = response.access_token
            self._credentials.expires_at = int(time()) + response.expires_in
            self._send_refresh()
            return response.access_token

        client = TidalClient(
            token=self._credentials.access_token,
            cache_name=None,
            omit_cache=True,
            on_token_expiry=refresh,
            proxies=proxies,
        )
        return TidalAPI(client, self._credentials.user_id, self._credentials.country_code)

    def _send_refresh(self) -> None:
        try:
            self._connection.sendall(
                (json.dumps(self._credentials.as_message(), separators=(",", ":")) + "\n").encode()
            )
        except OSError as error:
            raise SoneAuthError("could not return refreshed Sone credentials") from error
