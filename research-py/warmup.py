"""Build-time Docling model warmup (W1-B 模型预置).

Run inside the Docker build (WITH_DOCLING=1) with DOCLING_ARTIFACTS_PATH set:
converts a minimal VALID PDF to trigger layout/tableformer model download into
the image so runtime parsing never hits the HF Hub. Exit non-zero on failure so
the build fails loudly rather than shipping a model-less image.

The warmup payload is a hand-crafted minimal one-page PDF (371 bytes, text
"Warmup") — empty bytes are rejected by docling-parse (v0.9.9 build failure).
"""
import base64
import io
import sys

from docling.datamodel.base_models import DocumentStream
from docling.document_converter import DocumentConverter

MINIMAL_PDF = base64.b64decode(
    "JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5k"
    "b2JqCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9LaWRzWzMgMCBSXS9Db3VudCAxPj4KZW5kb2JqCjMgMCBv"
    "YmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9QYXJlbnQgMiAwIFIvUmVzb3VyY2Vz"
    "PDw+Pj4+PgplbmRvYmoKNCAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9I"
    "ZWx2ZXRpY2E+PgplbmRvYmoKNSAwIG9iago8PC9MZW5ndGggNTQ+PgpzdHJlYW0KQlQgLzEyIFRmIEhl"
    "bHZldGljYSAyNCA3NjggVGQgKEphbWVzKFR3b29rKVRqIEVUCmVuZHN0cmVhbQplbmRvYmoKMyAwIG9i"
    "ago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDYxMiA3OTJdL1BhcmVudCAyIDAgUi9SZXNvdXJjZXM8"
    "PC9Gb250PDwvRjEgNCAwIFI+Pj4+Pi9Db250ZW50cyA1IDAgUj4+CmVuZG9iagp4cmVmCjAgNgowMDAw"
    "MDAwMDAwMCA2NTUzNSBmCjAwMDAwMDAwMDA5IDAwMDAwIG4KMDAwMDAwMDAxNzQgMDAwMDAgbgowMDAw"
    "MDAwMDMxMCAwMDAwMCBuCjAwMDAwMDAwNDA3IDAwMDAwIG4KMDAwMDAwMDA0NjAgMDAwMDAgbgp0cmFp"
    "bGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjU2NQolJUVPRgo="
)

try:
    DocumentConverter().convert(DocumentStream(name="warm.pdf", stream=io.BytesIO(MINIMAL_PDF)))
    print("docling warmup ok (models cached to DOCLING_ARTIFACTS_PATH)")
except Exception as e:  # noqa: BLE001 — build guard must catch everything
    print(f"docling warmup failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
