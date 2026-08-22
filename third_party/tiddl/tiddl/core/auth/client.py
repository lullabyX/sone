import base64
import logging
from os import environ
from requests import request
from typing import Any, TypeAlias

from tiddl.core.auth.exceptions import AuthClientError

log = logging.getLogger("tiddl")


def get_auth_credentials() -> tuple[str, str]:
    ENV_KEY = "TIDDL_AUTH"

    client_id, client_secret = (
        base64.b64decode(
            "NE4zbjZRMXg5NUxMNUs3cDtvS09YZkpXMzcxY1g2eGFaMFB5aGdHTkJkTkxsQlpkNEFLS1lvdWdNamlrPQ=="
        )
        .decode()
        .split(";")
    )

    env_value = environ.get(ENV_KEY, None)

    if env_value:
        client_id, client_secret = env_value.split(";")

    log.debug(f"{client_id=}, {bool(env_value)=}")

    return client_id, client_secret


AUTH_URL = "https://auth.tidal.com/v1/oauth2"

JSON: TypeAlias = dict[str, Any]


class AuthClient:

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        proxies: dict[str, str] | None = None,
    ) -> None:
        self.auth_url = AUTH_URL
        if client_id is None or client_secret is None:
            default_client_id, default_client_secret = get_auth_credentials()
            client_id = client_id or default_client_id
            client_secret = client_secret or default_client_secret
        self.client_id = client_id
        self.client_secret = client_secret
        self.proxies = proxies

    def get_device_auth(self) -> JSON:
        res = request(
            "POST",
            f"{self.auth_url}/device_authorization",
            data={"client_id": self.client_id, "scope": "r_usr+w_usr+w_sub"},
        )

        res.raise_for_status()

        return res.json()

    def get_auth(self, device_code: str) -> JSON:
        request_options = {
            "data": {
                "client_id": self.client_id,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "scope": "r_usr+w_usr+w_sub",
            },
            "auth": (self.client_id, self.client_secret),
        }
        if self.proxies:
            request_options["proxies"] = self.proxies
        res = request(
            "POST",
            f"{self.auth_url}/token",
            **request_options,
        )

        json_data = res.json()

        if res.status_code != 200:
            raise AuthClientError(**json_data)

        return json_data

    def refresh_token(self, refresh_token: str) -> JSON:
        request_options = {
            "data": {
                "client_id": self.client_id,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
                "scope": "r_usr+w_usr+w_sub",
            },
            "auth": (self.client_id, self.client_secret),
        }
        if self.proxies:
            request_options["proxies"] = self.proxies
        res = request(
            "POST",
            f"{self.auth_url}/token",
            **request_options,
        )

        res.raise_for_status()

        return res.json()

    def logout_token(self, access_token: str) -> None:
        res = request(
            "POST",
            "https://api.tidal.com/v1/logout",
            headers={"authorization": f"Bearer {access_token}"},
        )

        res.raise_for_status()
