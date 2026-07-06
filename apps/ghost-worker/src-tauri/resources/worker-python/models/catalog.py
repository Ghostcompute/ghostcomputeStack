"""Load and enrich the curated model catalog."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_CATALOG_PATH = Path(__file__).with_name("catalog.json")
_SAFETY_MARGIN = 1.05
_TIGHT_MARGIN = 0.88


def load_catalog() -> list[dict[str, Any]]:
    with _CATALOG_PATH.open(encoding="utf-8") as fh:
        data = json.load(fh)
    return list(data.get("models") or [])


def get_catalog_entry(model_id: str) -> dict[str, Any] | None:
    for entry in load_catalog():
        if entry.get("id") == model_id:
            return dict(entry)
    return None


def compatibility_label(vram_total_gb: float, min_vram_gb: float) -> str:
    """Return fits | tight | no | unknown."""
    if vram_total_gb <= 0:
        return "unknown"
    if vram_total_gb >= min_vram_gb * _SAFETY_MARGIN:
        return "fits"
    if vram_total_gb >= min_vram_gb * _TIGHT_MARGIN:
        return "tight"
    return "no"


def _is_installed(model_id: str, backend: str, installed: set[str]) -> bool:
    if model_id in installed:
        return True
    if backend == "ollama":
        base = model_id.split(":")[0]
        for name in installed:
            if name == model_id or name.startswith(f"{base}:"):
                return True
    return False


def is_model_installed(model_id: str, backend: str, installed: set[str]) -> bool:
    return _is_installed(model_id, backend, installed)


def enrich_catalog(
    models: list[dict[str, Any]],
    *,
    vram_total_gb: float,
    installed: set[str],
    selected_id: str | None,
    selected_backend: str | None,
) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for raw in models:
        entry = dict(raw)
        min_vram = float(entry.get("min_vram_gb") or 0)
        entry["compatibility"] = compatibility_label(vram_total_gb, min_vram)
        entry["installed"] = is_model_installed(str(entry.get("id") or ""), str(entry.get("backend") or ""), installed)
        entry["active"] = (
            selected_id is not None
            and entry.get("id") == selected_id
            and entry.get("backend") == selected_backend
        )
        enriched.append(entry)
    return enriched
