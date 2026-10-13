"""Document parsing via Docling (PDF/DOCX only).

Docling is a heavy optional dependency: it is imported lazily on first use, so
the service stays healthy and importable without it. When Docling is missing
or parsing fails, the endpoint returns status="failed" with an error message
instead of raising a 500.

TXT/MD/HTML are intentionally NOT handled here — the Node side parses them
natively (see docs/specs/knowledge-rag.md).

Prices estimated from figures may only appear inside block text for knowledge
understanding; they must never be emitted as numeric fields.
"""

import asyncio
import base64
import binascii
import importlib.util
import io
import os
from typing import List, Optional, Tuple

import httpx

from .schemas import ParseBlock, ParseDocumentRequest, ParseDocumentResponse

_FETCH_TIMEOUT_SECONDS = 20.0
_MAX_FETCH_BYTES = 10 * 1024 * 1024  # 10MB
_SUPPORTED_EXTENSIONS = (".pdf", ".docx")


def docling_available() -> bool:
    """Cheap availability probe (no import) for the /health endpoint."""
    return importlib.util.find_spec("docling") is not None


async def _fetch_limited(url: str) -> bytes:
    async with httpx.AsyncClient(follow_redirects=True, timeout=_FETCH_TIMEOUT_SECONDS) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            content_length = resp.headers.get("content-length")
            if content_length is not None and int(content_length) > _MAX_FETCH_BYTES:
                raise ValueError(f"remote file exceeds {_MAX_FETCH_BYTES} byte limit")
            chunks: List[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > _MAX_FETCH_BYTES:
                    raise ValueError(f"remote file exceeds {_MAX_FETCH_BYTES} byte limit")
                chunks.append(chunk)
            return b"".join(chunks)


def _item_location(item) -> Tuple[Optional[int], Optional[List[float]]]:
    """Best-effort (pageNo, bbox) from a docling item's provenance."""
    try:
        prov = getattr(item, "prov", None) or []
        if not prov:
            return None, None
        p = prov[0]
        page_no = getattr(p, "page_no", None)
        bbox = getattr(p, "bbox", None)
        bbox_list = None
        if bbox is not None:
            bbox_list = [float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)]
        return page_no, bbox_list
    except Exception:
        return None, None


def _convert_with_docling(file_name: str, data: bytes) -> Tuple[List[ParseBlock], Optional[int]]:
    """Synchronous docling conversion; run in a worker thread by the caller."""
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(DocumentStream(name=file_name, stream=io.BytesIO(data)))
    doc = result.document

    blocks: List[ParseBlock] = []

    def _text_of(item) -> str:
        text = getattr(item, "text", None)
        if text:
            return text
        try:
            return item.export_to_markdown(doc)
        except Exception:
            return ""

    for item in getattr(doc, "texts", []) or []:
        page_no, bbox = _item_location(item)
        blocks.append(ParseBlock(kind="text", text=_text_of(item), pageNo=page_no, bbox=bbox))

    for item in getattr(doc, "tables", []) or []:
        page_no, bbox = _item_location(item)
        blocks.append(ParseBlock(kind="table", text=_text_of(item), pageNo=page_no, bbox=bbox))

    for item in getattr(doc, "pictures", []) or []:
        page_no, bbox = _item_location(item)
        caption = ""
        try:
            caption = item.caption_text(doc) or ""
        except Exception:
            pass
        # Figure blocks keep their caption/self-ref only; no numeric price
        # extraction from images is ever performed here.
        blocks.append(
            ParseBlock(
                kind="figure",
                text=caption or None,
                pageNo=page_no,
                figureId=getattr(item, "self_ref", None),
                bbox=bbox,
            )
        )

    page_count: Optional[int] = None
    try:
        page_count = len(doc.pages) or None
    except Exception:
        pass
    return blocks, page_count


async def parse_document(req: ParseDocumentRequest) -> ParseDocumentResponse:
    def fail(error: str) -> ParseDocumentResponse:
        return ParseDocumentResponse(docId=req.docId, status="failed", error=error, blocks=[])

    ext = os.path.splitext(req.fileName)[1].lower()
    if ext not in _SUPPORTED_EXTENSIONS:
        return fail(f"unsupported file type {ext or '(none)'}: only PDF/DOCX are parsed by docling")

    if not docling_available():
        return fail("docling is not installed in this environment")

    try:
        if req.contentBase64 is not None:
            data = base64.b64decode(req.contentBase64, validate=True)
        else:
            data = await _fetch_limited(req.fetchUrl)  # type: ignore[arg-type]
    except (binascii.Error, ValueError) as e:
        return fail(f"failed to obtain document bytes: {e}")
    except httpx.HTTPError as e:
        return fail(f"failed to fetch document: {e}")

    try:
        blocks, page_count = await asyncio.to_thread(_convert_with_docling, req.fileName, data)
    except Exception as e:  # parsing failures are data, not server errors
        return fail(f"docling parse failed: {type(e).__name__}: {e}")

    return ParseDocumentResponse(
        docId=req.docId,
        status="ok",
        blocks=blocks,
        pageCount=page_count,
    )
