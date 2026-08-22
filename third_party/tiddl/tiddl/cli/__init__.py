import logging

from tiddl.cli.const import APP_PATH
from tiddl.sone_tiddl.runtime import is_enabled

log = logging.getLogger("tiddl")
log.setLevel(logging.DEBUG)

if not is_enabled():
    APP_PATH.mkdir(exist_ok=True)
    file_handler = logging.FileHandler(APP_PATH / "latest.log", encoding="utf-8", mode="w")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s\t[%(name)s.%(funcName)s] %(message)s"
        )
    )
    log.addHandler(file_handler)
