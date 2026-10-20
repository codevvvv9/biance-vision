"""FastAPI application: fixed task endpoints only. No arbitrary code execution."""

import sklearn
from fastapi import FastAPI, HTTPException

from . import modeling, parsing, translation
from .schemas import (
    CalibrationReportRequest,
    CalibrationReportResponse,
    ParseDocumentRequest,
    ParseDocumentResponse,
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
        "argos": translation._argos_available(),
        "argosPairs": sorted(["->".join(p) for p in translation._installed_pairs()]),
        "sklearnVersion": sklearn.__version__,
    }


@app.post("/tasks/parse-document", response_model=ParseDocumentResponse)
async def parse_document(req: ParseDocumentRequest) -> ParseDocumentResponse:
    # parsing.parse_document never raises for parse-level failures; it returns
    # status="failed" + error instead.
    return await parsing.parse_document(req)


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
