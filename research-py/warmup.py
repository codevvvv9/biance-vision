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
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzNyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoV2FybXVwKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDAzMjggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozOTgKJSVFT0Y="
)

try:
    DocumentConverter().convert(DocumentStream(name="warm.pdf", stream=io.BytesIO(MINIMAL_PDF)))
    cache = os.path.expanduser("~/.cache/docling")
    print(f"docling warmup ok (models cached to {cache})")
except Exception as e:  # noqa: BLE001 — build guard must catch everything
    print(f"docling warmup failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
