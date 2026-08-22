import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from tiddl.sone_tiddl.auth import AUTH_FD, CredentialSnapshot, SoneAuthProvider


def credential_message():
    return {
        "type": "credentials",
        "credentials": {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "user_id": "42",
            "country_code": "US",
            "client_id": "client-id",
            "client_secret": "client-secret",
        },
    }


def test_provider_reads_credentials_from_inherited_socket():
    parent, child = socket.socketpair()
    try:
        parent.sendall((json.dumps(credential_message()) + "\n").encode())

        provider = SoneAuthProvider.from_inherited_socket(child.detach())

        assert provider._credentials.access_token == "access-token"
        assert provider._credentials.country_code == "US"
    finally:
        parent.close()


def test_auth_fd_is_not_an_environment_variable():
    assert AUTH_FD == 3


def test_integrated_mode_does_not_create_tiddl_home(tmp_path):
    project_root = Path(__file__).parents[2]
    python_path = str(project_root)
    if existing_path := os.environ.get("PYTHONPATH"):
        python_path = f"{python_path}{os.pathsep}{existing_path}"
    environment = os.environ | {"HOME": str(tmp_path), "PYTHONPATH": python_path}
    subprocess.run(
        [
            sys.executable,
            "-c",
            "from tiddl.sone_tiddl.runtime import enable; enable(); import tiddl.cli",
        ],
        check=True,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
    )

    assert not (tmp_path / ".tiddl").exists()


def test_refreshed_credentials_are_only_written_to_private_socket():
    parent, child = socket.socketpair()
    try:
        provider = SoneAuthProvider(child, CredentialSnapshot.from_message(credential_message()))
        provider._credentials.access_token = "new-access-token"
        provider._send_refresh()

        message = json.loads(parent.recv(4096))
        assert message["type"] == "credentials_refreshed"
        assert message["credentials"]["access_token"] == "new-access-token"
    finally:
        parent.close()
        child.close()


def test_credentials_are_not_written_to_standard_streams_logs_or_tiddl_home(tmp_path, capsys, caplog):
    parent, child = socket.socketpair()
    message = credential_message()
    secret_values = tuple(message["credentials"].values())
    try:
        provider = SoneAuthProvider(child, CredentialSnapshot.from_message(message))
        provider._credentials.access_token = "refreshed-access-token"
        provider._send_refresh()

        captured = capsys.readouterr()
        assert not any(secret in captured.out for secret in secret_values)
        assert not any(secret in captured.err for secret in secret_values)
        assert "refreshed-access-token" not in captured.out
        assert "refreshed-access-token" not in captured.err
        assert not any(secret in caplog.text for secret in secret_values)
        assert "refreshed-access-token" not in caplog.text
        assert not (tmp_path / ".tiddl").exists()

        refresh = parent.recv(4096).decode()
        assert "refreshed-access-token" in refresh
    finally:
        parent.close()
        child.close()
