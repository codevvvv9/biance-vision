"""Offline translation via Argos Translate (Part 2 translation agent fallback).

Argostranslate is an optional heavy dependency (CTranslate2 runtime): it is
imported lazily inside translate(), so the rest of the service stays healthy
without it. Language pairs are offline packages that must be downloaded
beforehand (see scripts/download_argos_packs.py); a missing pair returns the
structured error code `package_missing` instead of a 500.

This module performs no network access at runtime: everything runs locally
against the installed .argosmodel packages.
"""

from typing import Optional

from fastapi import HTTPException

from .schemas import TranslateRequest, TranslateResponse

# Argos language pairs shipped with this deployment (scripts/download_argos_packs.py).
# zh↔en only — other target languages are handled by the LLM path in Node.
SUPPORTED_PAIRS = {("zh", "en"), ("en", "zh")}


def _argos_available() -> bool:
    try:
        import argostranslate.translate  # noqa: F401

        return True
    except Exception:
        return False


def _installed_pairs() -> set:
    """Directional pairs currently installed as offline packages."""
    try:
        import argostranslate.package

        pairs = set()
        for pkg in argostranslate.package.get_installed_packages():
            if getattr(pkg, "from_code", None) and getattr(pkg, "to_code", None):
                pairs.add((pkg.from_code, pkg.to_code))
        return pairs
    except Exception:
        return set()


def _detect_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def translate(req: TranslateRequest) -> TranslateResponse:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")

    source = req.sourceLang
    target = req.targetLang
    if source == "auto":
        # Naive detection: CJK-dominant → zh, otherwise en (the only pair we ship)
        source = "zh" if _detect_cjk(req.text) else "en"
    if source == target:
        raise HTTPException(status_code=400, detail="sourceLang and targetLang must differ")

    if not _argos_available():
        return TranslateResponse(
            status="failed",
            error="package_missing",
            text=None,
            detectedLang=source if req.sourceLang == "auto" else None,
        )
    if (source, target) not in SUPPORTED_PAIRS or (source, target) not in _installed_pairs():
        return TranslateResponse(
            status="failed",
            error="package_missing",
            text=None,
            detectedLang=source if req.sourceLang == "auto" else None,
        )

    import argostranslate.translate

    try:
        out = argostranslate.translate.translate(req.text, source, target)
    except Exception as e:  # noqa: BLE001 - surface engine failure as remote error
        raise HTTPException(status_code=500, detail=f"argos translate failed: {e}") from e

    return TranslateResponse(
        status="ok",
        error=None,
        text=out,
        detectedLang=source if req.sourceLang == "auto" else None,
    )
