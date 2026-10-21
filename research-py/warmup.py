"""Build-time Docling model warmup (W1-B 模型预置).

Run inside the Docker build (WITH_DOCLING=1): converts a minimal VALID PDF to
trigger layout/tableformer model download into the image's default cache
(~/.cache/docling) so runtime parsing never hits the HF Hub. The Dockerfile
then points DOCLING_ARTIFACTS_PATH at that cache for runtime.

Note: DOCLING_ARTIFACTS_PATH must NOT be set during warmup — docling validates
that the folder already contains all required models and fails on an empty
directory (v0.10.0 build failure). Exit non-zero on any failure.
"""
import base64
import io
import os
import sys

os.environ.pop("DOCLING_ARTIFACTS_PATH", None)

from docling.datamodel.base_models import DocumentStream  # noqa: E402
from docling.document_converter import DocumentConverter  # noqa: E402

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
    cache = os.path.expanduser("~/.cache/docling")
    print(f"docling warmup ok (models cached to {cache})")
except Exception as e:  # noqa: BLE001 — build guard must catch everything
    print(f"docling warmup failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
