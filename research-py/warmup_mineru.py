"""Build-time MinerU (magic-pdf) model warmup (R2 双引擎模型预置).

Run inside the Docker build (WITH_MINERU=1): parses a minimal VALID PDF using
the magic-pdf CLI to trigger model downloads into the image's default model
cache directory. Exit non-zero on failure so the build fails loudly.

The minimal PDF is the same one used by the Docling warmup (warmup.py).
"""
import base64
import subprocess
import sys
import tempfile
import os

MINIMAL_PDF = base64.b64decode(
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzNyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoV2FybXVwKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMDAzMjggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozOTgKJSVFT0Y="
)

def find_cli():
    for cmd in ("mineru", "magic-pdf"):
        try:
            r = subprocess.run(["which", cmd], capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                return cmd
        except Exception:
            pass
    return None

cli = find_cli()
if cli is None:
    print("warmup_mineru: no CLI found (mineru/magic-pdf)", file=sys.stderr)
    sys.exit(1)

with tempfile.TemporaryDirectory(prefix="mineru_warmup_") as workdir:
    pdf_path = os.path.join(workdir, "warm.pdf")
    output_dir = os.path.join(workdir, "output")
    os.makedirs(output_dir)

    with open(pdf_path, "wb") as f:
        f.write(MINIMAL_PDF)

    try:
        result = subprocess.run(
            [cli, "-p", pdf_path, "-o", output_dir],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=workdir,
        )
        if result.returncode != 0:
            print(f"warmup_mineru: CLI failed (exit {result.returncode}): {result.stderr[-300:]}", file=sys.stderr)
            sys.exit(1)
        print(f"warmup_mineru: ok (models cached, CLI={cli})")
    except subprocess.TimeoutExpired:
        print("warmup_mineru: timeout (300s) — model download too slow", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"warmup_mineru: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
