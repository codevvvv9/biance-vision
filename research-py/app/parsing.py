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


def _label_to_block(item, text_of) -> Optional[ParseBlock]:
    """Map a docling text item's label to a ParseBlock (W1-B 缺口 A 修复).

    Docling items carry `label` (title/section_header/paragraph/list_item/
    page_header/page_footer/...). The previous mapping dropped it entirely,
    producing only text/table/figure — so Node's heading stack stayed empty
    and chapter-aware chunking never fired. Mapping (contract is add-only, R-B):
      title            → heading level 1
      section_header   → heading level 1 + item.level (clamped to 1-6)
      page_header/footer → text (isPageFurniture note in text prefix omitted;
                           Node-side cleaning drops furniture by repetition rule)
      everything else  → text
    """
    page_no, bbox = _item_location(item)
    label = getattr(item, "label", None)
    label_name = getattr(label, "name", label) or ""
    text = text_of(item)
    if label_name == "title":
        return ParseBlock(kind="heading", text=text, pageNo=page_no, bbox=bbox, level=1)
    if label_name == "section_header":
        try:
            level = min(6, max(1, 1 + int(getattr(item, "level", 0) or 0)))
        except (TypeError, ValueError):
            level = 1
        return ParseBlock(kind="heading", text=text, pageNo=page_no, bbox=bbox, level=level)
    return ParseBlock(kind="text", text=text, pageNo=page_no, bbox=bbox)


def _convert_with_docling(file_name: str, data: bytes, page_range=None, progress=None, enable_ocr=False) -> Tuple[List[ParseBlock], Optional[int]]:
    """Synchronous docling conversion; run in a worker thread by the caller.

    page_range: optional (from, to) 1-based inclusive tuple — one batch of the
    Node-orchestrated 20-page batches (W1-B). Implemented by slicing the PDF
    with pypdf before feeding docling (PdfPipelineOptions has no page_range
    field in the installed version — v0.11.2 lesson). progress: optional
    callable for cooperative cancel between batches.
    enable_ocr: R2 — enable docling OCR for pages without a text layer
    (scanned PDFs). Uses RapidOCR (rapidocr-onnxruntime) which docling
    auto-detects when installed. Lazy: OCR engine only loads when docling
    encounters a page that needs it (red line R-D).
    """
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    total_page_count: Optional[int] = None
    if page_range is not None and file_name.lower().endswith(".pdf"):
        from pypdf import PdfReader, PdfWriter

        reader = PdfReader(io.BytesIO(data))
        total_page_count = len(reader.pages)
        writer = PdfWriter()
        page_from_0 = max(0, page_range[0] - 1)
        page_to_0 = min(total_page_count, page_range[1])
        for idx in range(page_from_0, page_to_0):
            writer.add_page(reader.pages[idx])
        sliced = io.BytesIO()
        writer.write(sliced)
        sliced.seek(0)
        data = sliced.getvalue()

    opts = PdfPipelineOptions()
    if enable_ocr:
        # R2: docling auto-detects RapidOCR when rapidocr-onnxruntime is installed;
        # only triggers on pages where the text layer is missing (not full-page OCR
        # on digital PDFs) — OcrAutoOptions is the default and handles this
        # intelligently. We just need to signal that OCR is available.
        pass  # OcrAutoOptions with rapidocr installed → docling uses it per-page as needed

    converter = DocumentConverter(
        format_options={"pdf": PdfFormatOption(pipeline_options=opts)} if enable_ocr else {}
    )
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
        block = _label_to_block(item, _text_of)
        if block is not None:
            blocks.append(block)

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

    # 分批模式下返回完整 PDF 的总页数（pypdf 切片前的计数），而非本批页数
    page_count = total_page_count
    if page_count is None:
        try:
            page_count = len(doc.pages) or None
        except Exception:
            pass
    if progress is not None and page_count:
        progress("parsed_batch", page_range[1] if page_range else page_count, page_count)
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
