"""MinerU integration: alternative PDF parsing engine (R2 多路径兜底).

MinerU (magic-pdf) excels at:
- Scanned PDFs (built-in OCR, no separate RapidOCR needed)
- Complex layouts (multi-column, tables with merged cells, formulas)
- Chinese + English mixed content
- Heading level detection (text_level in content_list)

Integration approach: subprocess call to `mineru` CLI (avoids Python API
version coupling). The CLI outputs content_list.json which we convert to
the same ParsedBlock[] format as docling.

Memory management: MinerU models (~1.5GB) load lazily on first call.
Do NOT run docling and MinerU simultaneously — the caller must route
to one engine based on PDF type inspection.
"""

import json
import os
import subprocess
import tempfile
from typing import List, Optional, Tuple

from .schemas import ParseBlock


def mineru_available() -> bool:
    """Check if the magic-pdf CLI is installed (the 'mineru' name is v2+; v1.x uses magic-pdf)."""
    for cmd in ("mineru", "magic-pdf"):
        try:
            result = subprocess.run(["which", cmd], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return True
        except Exception:
            pass
    return False


def _mineru_command() -> str:
    """Return the available CLI command name."""
    for cmd in ("mineru", "magic-pdf"):
        try:
            result = subprocess.run(["which", cmd], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return cmd
        except Exception:
            pass
    raise RuntimeError("neither 'mineru' nor 'magic-pdf' CLI found")


def parse_with_mineru(
    file_name: str, data: bytes, page_from: Optional[int] = None, page_to: Optional[int] = None
) -> Tuple[List[ParseBlock], Optional[int]]:
    """Parse a PDF using MinerU CLI and convert to ParseBlock[].

    Returns (blocks, total_page_count). Raises RuntimeError on failure.
    """
    if not mineru_available():
        raise RuntimeError("magic-pdf CLI not installed (requires magic-pdf package)")

    cli_cmd = _mineru_command()

    with tempfile.TemporaryDirectory(prefix="mineru_") as workdir:
        pdf_path = os.path.join(workdir, "input.pdf")
        output_dir = os.path.join(workdir, "output")
        os.makedirs(output_dir, exist_ok=True)

        with open(pdf_path, "wb") as f:
            f.write(data)

        cmd = [
            cli_cmd,
            "-p", pdf_path,
            "-o", output_dir,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minutes per document (caller handles overall budget)
            cwd=workdir,
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"mineru CLI failed (exit {result.returncode}): "
                f"{result.stderr[-500:] if result.stderr else 'unknown error'}"
            )

        # Find content_list.json in output directory
        content_list_path = None
        for root, _dirs, files in os.walk(output_dir):
            for f in files:
                if f.endswith("_content_list.json"):
                    content_list_path = os.path.join(root, f)
                    break
            if content_list_path:
                break

        if not content_list_path:
            raise RuntimeError("mineru produced no content_list.json")

        with open(content_list_path, "r", encoding="utf-8") as f:
            content_list = json.load(f)

        # Convert to ParseBlock[]
        blocks: List[ParseBlock] = []
        total_pages = 0

        for item in content_list:
            page_idx = item.get("page_idx", 0)
            total_pages = max(total_pages, page_idx + 1)
            # Apply page range filter if specified (1-based inclusive)
            if page_from is not None and page_to is not None:
                if page_idx + 1 < page_from or page_idx + 1 > page_to:
                    continue

            item_type = item.get("type", "text")

            if item_type == "image":
                blocks.append(ParseBlock(
                    kind="figure",
                    text=item.get("img_caption") or None,
                    pageNo=page_idx + 1,
                    figureId=item.get("img_path"),
                ))
            elif item_type == "table":
                blocks.append(ParseBlock(
                    kind="table",
                    text=item.get("table_body") or item.get("table_caption") or "",
                    pageNo=page_idx + 1,
                ))
            elif item_type == "equation":
                # Treat equations as text (inline math rendered as LaTeX)
                blocks.append(ParseBlock(
                    kind="text",
                    text=item.get("text", ""),
                    pageNo=page_idx + 1,
                ))
            else:
                # text type — check for heading level
                text_level = item.get("text_level", 0)
                if text_level and text_level > 0:
                    blocks.append(ParseBlock(
                        kind="heading",
                        text=item.get("text", ""),
                        pageNo=page_idx + 1,
                        level=min(6, max(1, int(text_level))),
                    ))
                else:
                    blocks.append(ParseBlock(
                        kind="text",
                        text=item.get("text", ""),
                        pageNo=page_idx + 1,
                    ))

        return blocks, total_pages if total_pages > 0 else None
