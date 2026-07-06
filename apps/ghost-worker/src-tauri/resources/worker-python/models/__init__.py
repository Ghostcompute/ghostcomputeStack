"""Model catalog, compatibility filtering, download, and selection."""

from .catalog import compatibility_label, enrich_catalog, load_catalog
from .manager import (
    get_download_status,
    get_selection,
    list_installed,
    select_model,
    start_download,
)

__all__ = [
    "load_catalog",
    "enrich_catalog",
    "compatibility_label",
    "list_installed",
    "get_selection",
    "select_model",
    "start_download",
    "get_download_status",
]
