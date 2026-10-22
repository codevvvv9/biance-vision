"""PDF pre-check (inspect): detect scanned vs. digital PDFs before parsing.

R2 (rag-pipeline-design §4.1): uses pypdf (already a dependency) to count
pages with extractable text — a text-char ratio < 0.3 indicates a scanned
PDF that needs the OCR route; ≤30 pages can OCR online, >30 pages should
use the offline import channel.
"""

from pypdf import PdfReader
import io


def inspect_pdf(data: bytes) -> dict:
    """Check text layer coverage of a PDF.

    Returns {pageCount, encrypted, textCharRatio, emptyPageCount}.
    textCharRatio = pages with >50 extractable chars / total pages.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:
        return {"error": f"cannot read PDF: {type(e).__name__}: {e}"}

    if reader.is_encrypted:
        return {"pageCount": 0, "encrypted": True, "textCharRatio": 0.0, "emptyPageCount": 0}

    total = len(reader.pages)
    if total == 0:
        return {"pageCount": 0, "encrypted": False, "textCharRatio": 0.0, "emptyPageCount": 0}

    pages_with_text = 0
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
            if len(text.strip()) > 50:
                pages_with_text += 1
        except Exception:
            pass

    ratio = pages_with_text / total if total > 0 else 0.0
    return {
        "pageCount": total,
        "encrypted": False,
        "textCharRatio": round(ratio, 3),
        "emptyPageCount": total - pages_with_text,
    }
