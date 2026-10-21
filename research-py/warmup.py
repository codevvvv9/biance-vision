"""Build-time Docling model warmup (W1-B 模型预置).

Run inside the Docker build (WITH_DOCLING=1) with DOCLING_ARTIFACTS_PATH set:
converts a minimal PDF to trigger layout/tableformer model download into the
image so runtime parsing never hits the HF Hub. Exit non-zero on failure so
the build fails loudly rather than shipping a model-less image.
"""
import io
import sys

from docling.datamodel.base_models import DocumentStream
from docling.document_converter import DocumentConverter

try:
    DocumentConverter().convert(DocumentStream(name="warm.pdf", stream=io.BytesIO(b"")))
    print("docling warmup ok (models cached to DOCLING_ARTIFACTS_PATH)")
except Exception as e:  # noqa: BLE001 — build guard must catch everything
    print(f"docling warmup failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
