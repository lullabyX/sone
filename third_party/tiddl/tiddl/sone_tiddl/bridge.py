"""Private Sone-only JSONL download entrypoint."""

import sys

from tiddl.sone_tiddl.runtime import enable

# This must happen before importing tiddl.cli: that package normally creates
# ~/.tiddl and its log file as part of the standalone CLI initialization.
enable()

import typer
from rich.console import Console
from typing_extensions import Annotated

from tiddl.cli.commands.download import download_command
from tiddl.cli.ctx import Context, ContextObject
from tiddl.sone_tiddl.auth import SoneAuthError, SoneAuthProvider


app = typer.Typer(name="sone-tiddl", no_args_is_help=True, rich_markup_mode=None)
app.add_typer(download_command, name="download")


def is_jsonl_download(arguments: list[str]) -> bool:
    if len(arguments) < 2 or arguments[1] != "download":
        return False
    return "--events=jsonl" in arguments or any(
        option == "--events" and value == "jsonl"
        for option, value in zip(arguments, arguments[1:])
    )


@app.callback(invoke_without_command=True)
def callback(
    ctx: Context,
    capabilities: Annotated[bool, typer.Option("--capabilities", hidden=True)] = False,
) -> None:
    if capabilities:
        typer.echo("sone-tiddl jsonl-v1")
        raise typer.Exit()
    if not is_jsonl_download(sys.argv):
        raise typer.BadParameter("only `download --events jsonl` is available")
    try:
        provider = SoneAuthProvider.from_inherited_socket()
    except SoneAuthError as error:
        raise typer.BadParameter("Sone authentication is unavailable") from error
    ctx.obj = ContextObject(
        api_omit_cache=True,
        console=Console(stderr=True),
        debug_path=None,
        auth_provider=provider,
    )


if __name__ == "__main__":
    app()
