"""FastAPI application: fixed task endpoints only. No arbitrary code execution."""

import sklearn
from fastapi import FastAPI, HTTPException

from . import modeling, parsing, parsing_async, translation
from . import mineru_parser
from .inspect_pdf import inspect_pdf
from .schemas import (
    CalibrationReportRequest,
    CalibrationReportResponse,
    ParseAsyncRequest,
    ParseDocumentRequest,
    ParseDocumentResponse,
    ParseTaskSnapshot,
    PredictRequest,
    PredictResponse,
    TrainRequest,
    TrainResponse,
    TranslateRequest,
    TranslateResponse,
)

app = FastAPI(title="research-py", version="0.1.0")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "docling": parsing.docling_available(),
        "mineru": mineru_parser.mineru_available(),
        "argos": translation._argos_available(),
        "argosPairs": sorted(["->".join(p) for p in translation._installed_pairs()]),
        "sklearnVersion": sklearn.__version__,
    }


# ---- R2 双引擎：MinerU 解析端点（扫描版/复杂版面的备选引擎）----

@app.post("/tasks/parse-mineru")
async def parse_mineru(req: dict):
    """Parse PDF using MinerU (better for scans/complex layouts than docling).

    Input: {docId, fileName, contentBase64}. Output: same format as parse-document.
    MinerU handles OCR internally — no separate RapidOCR needed.
    """
    import base64
    import binascii
    import asyncio

    doc_id = req.get("docId", "unknown")
    file_name = req.get("fileName", "")
    b64 = req.get("contentBase64", "")

    if not b64 or not file_name:
        raise HTTPException(status_code=422, detail="docId/fileName/contentBase64 required")
    if not file_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="mineru only supports PDF files")
    if not mineru_parser.mineru_available():
        raise HTTPException(status_code=503, detail="mineru CLI not installed")

    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"invalid base64: {e}")

    try:
        blocks, page_count = await asyncio.to_thread(
            mineru_parser.parse_with_mineru, file_name, data
        )
    except RuntimeError as e:
        return {"docId": doc_id, "status": "failed", "error": str(e), "blocks": []}
    except Exception as e:
        return {"docId": doc_id, "status": "failed", "error": f"mineru unexpected: {type(e).__name__}: {e}", "blocks": []}

    return {
        "docId": doc_id,
        "status": "ok",
        "blocks": [b.model_dump() for b in blocks],
        "pageCount": page_count,
    }


# ---- R2 预检端点（rag-pipeline §4.1：扫描版/数字版路由判定）----

@app.post("/tasks/inspect")
def inspect_document(req: dict):
    """Pre-check a PDF's text layer coverage. Input: {contentBase64}. Output:
    {pageCount, encrypted, textCharRatio, emptyPageCount}. Node uses this to
    route: ratio < 0.3 → scanned (OCR if ≤30 pages, offline guidance if more).
    """
    import base64
    import binascii

    b64 = req.get("contentBase64", "")
    if not b64:
        raise HTTPException(status_code=422, detail="contentBase64 required")
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"invalid base64: {e}")
    result = inspect_pdf(data)
    if "error" in result:
        raise HTTPException(status_code=422, detail=result["error"])
    return result


@app.post("/tasks/parse-document", response_model=ParseDocumentResponse)
async def parse_document(req: ParseDocumentRequest) -> ParseDocumentResponse:
    # parsing.parse_document never raises for parse-level failures; it returns
    # status="failed" + error instead.
    return await parsing.parse_document(req)


# ---- W1-B async parse tasks（docs/rag-pipeline-design.md §4.3；固定端点纪律不变）----

@app.post("/tasks/parse-document-async", response_model=ParseTaskSnapshot)
async def parse_document_async(req: ParseAsyncRequest) -> ParseTaskSnapshot:
    if not parsing.docling_available():
        raise HTTPException(status_code=503, detail="docling is not installed in this environment")
    return parsing_async.submit_parse(req)


@app.get("/tasks/parse-status/{task_id}", response_model=ParseTaskSnapshot)
def parse_status(task_id: str, includeBlocks: bool = False):
    snap = parsing_async.parse_status(task_id, include_blocks=includeBlocks)
    if snap is None:
        raise HTTPException(status_code=404, detail="task not found")
    return snap


@app.post("/tasks/parse-cancel/{task_id}", response_model=ParseTaskSnapshot)
def parse_cancel(task_id: str):
    snap = parsing_async.cancel_parse(task_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="task not found")
    return snap


@app.post("/tasks/train", response_model=TrainResponse)
def train(req: TrainRequest) -> TrainResponse:
    try:
        return modeling.train(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/tasks/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    try:
        return modeling.predict(req)
    except modeling.ArtifactNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/tasks/calibration-report", response_model=CalibrationReportResponse)
def calibration_report(req: CalibrationReportRequest) -> CalibrationReportResponse:
    return modeling.calibration_report(req)


@app.post("/tasks/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest) -> TranslateResponse:
    # 400/500 raise HTTPException; a missing offline language pair returns
    # status="failed" + error="package_missing" (structured, not an exception),
    # so the Node side can degrade explicitly.
    return translation.translate(req)
