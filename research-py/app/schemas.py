"""Pydantic request/response schemas for the fixed task endpoints.

Field naming follows the shared Node contract (shared/src/contract/predictions.ts):
modelVersion / featureVersion / probabilityUp / quantiles (record "0.1" -> value).
"""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# parse-document
# ---------------------------------------------------------------------------

class ParseBlock(BaseModel):
    kind: Literal["text", "figure", "table", "heading"]
    text: Optional[str] = None
    pageNo: Optional[int] = None
    figureId: Optional[str] = None
    # Bounding box as [left, top, right, bottom] in PDF page coordinates when known.
    bbox: Optional[List[float]] = None
    # heading 层级（1-6）；kind=heading 时由 docling label 映射（title→1，
    # section_header→1+item.level）。契约只增不改（红线 R-B）。
    level: Optional[int] = None


class ParseDocumentRequest(BaseModel):
    docId: str = Field(min_length=1)
    fileName: str = Field(min_length=1)
    contentBase64: Optional[str] = None
    fetchUrl: Optional[str] = None


# ---------------------------------------------------------------------------
# parse-document-async / parse-status / parse-cancel（W1-B 异步任务化）
# ---------------------------------------------------------------------------

class ParseAsyncRequest(BaseModel):
    taskId: str = Field(min_length=1)
    docId: str = Field(min_length=1)
    fileName: str = Field(min_length=1)
    contentBase64: str
    """页范围（1-based 闭区间）；缺省=整档。分批由 Node 侧编排：20 页/批顺序提交"""
    pageFrom: Optional[int] = Field(default=None, ge=1)
    pageTo: Optional[int] = Field(default=None, ge=1)


class ParseEvent(BaseModel):
    seq: int
    stage: str
    message: Optional[str] = None
    atMs: int
    durationMs: Optional[int] = None


class ParseTaskSnapshot(BaseModel):
    taskId: str
    status: Literal["pending", "running", "completed", "failed", "cancelled"]
    stage: Optional[str] = None
    pageNo: Optional[int] = None
    totalPages: Optional[int] = None
    error: Optional[str] = None
    events: List[ParseEvent] = []
    blocks: Optional[List[ParseBlock]] = None
    pageCount: Optional[int] = None

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "ParseDocumentRequest":
        if (self.contentBase64 is None) == (self.fetchUrl is None):
            raise ValueError("exactly one of contentBase64 / fetchUrl is required")
        return self


class ParseDocumentResponse(BaseModel):
    docId: str
    status: Literal["ok", "failed"]
    error: Optional[str] = None
    blocks: List[ParseBlock] = Field(default_factory=list)
    pageCount: Optional[int] = None


# ---------------------------------------------------------------------------
# train
# ---------------------------------------------------------------------------

class TrainRow(BaseModel):
    features: Dict[str, float]
    labelReturn: float
    # Time-splitting decisions are made by the Node caller; this service only
    # honors the provided split labels and never re-splits by time itself.
    split: Literal["dev", "calibration", "test"]


DEFAULT_QUANTILES: List[float] = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]


class TrainRequest(BaseModel):
    modelVersion: str = Field(min_length=1)
    horizon: str = Field(min_length=1)
    featureVersion: str = Field(min_length=1)
    quantiles: Optional[List[float]] = None
    rows: List[TrainRow] = Field(min_length=1)
    artifactDir: Optional[str] = None

    @model_validator(mode="after")
    def _check_quantiles(self) -> "TrainRequest":
        qs = self.quantiles if self.quantiles is not None else DEFAULT_QUANTILES
        if not qs:
            raise ValueError("quantiles must be non-empty")
        for q in qs:
            if not (0.0 < q < 1.0):
                raise ValueError(f"quantile {q} out of (0, 1)")
        if len(set(qs)) != len(qs):
            raise ValueError("quantiles must be unique")
        self.quantiles = sorted(qs)
        return self


class ReliabilityBin(BaseModel):
    bin: str  # e.g. "0.0-0.1"
    avgPred: Optional[float] = None  # None when the bin is empty
    freq: Optional[float] = None
    count: int


class ProbabilityReport(BaseModel):
    brier: Optional[float] = None
    reliabilityBins: List[ReliabilityBin] = Field(default_factory=list)
    sampleSize: int


class SplitMetrics(BaseModel):
    # quantile level (string) -> empirical coverage (fraction of labels <= prediction)
    coverage: Dict[str, float] = Field(default_factory=dict)
    probabilityUp: Optional[ProbabilityReport] = None
    sampleSize: int


class TrainMetrics(BaseModel):
    # split name -> metrics; splits without rows are omitted
    splits: Dict[str, SplitMetrics]
    sampleSize: Dict[str, int]


class CalibrationReport(BaseModel):
    brier: Optional[float] = None
    reliabilityBins: List[ReliabilityBin] = Field(default_factory=list)
    quantileCoverage: Dict[str, float] = Field(default_factory=dict)
    sampleSize: int = 0


class TrainResponse(BaseModel):
    modelVersion: str
    artifactPath: str
    metrics: TrainMetrics
    featureNames: List[str]
    trainedRows: int
    calibrationReport: CalibrationReport
    # True when the isotonic level-remap calibrator was fit on the calibration
    # split and persisted inside the artifact (publish gate requires this).
    calibrated: bool = False
    calibrationRows: int = 0


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

class PredictRow(BaseModel):
    features: Dict[str, float]


class PredictRequest(BaseModel):
    modelVersion: str = Field(min_length=1)
    rows: List[PredictRow] = Field(min_length=1)
    artifactDir: Optional[str] = None


class CalibrationMeta(BaseModel):
    # Calibration mapping bound to this artifact ("isotonic" level remap);
    # None when the artifact carries no calibrator (must not be published).
    kind: str
    calRows: int


class PredictionOut(BaseModel):
    # quantile level (string, e.g. "0.05") -> predicted return
    quantiles: Dict[str, float]
    # isotonic-remapped level -> predicted return; probability interpolation
    # (EV / three-way / direction) must use this grid, not the nominal one
    calibratedQuantiles: Dict[str, float] = Field(default_factory=dict)
    probabilityUp: float
    # True when the quantile range does not straddle 0 and probabilityUp was
    # clamped to the nearest boundary instead of interpolated.
    degenerate: bool = False


class PredictResponse(BaseModel):
    modelVersion: str
    featureNames: List[str]
    predictions: List[PredictionOut]
    warnings: List[str] = Field(default_factory=list)
    calibration: Optional[CalibrationMeta] = None


# ---------------------------------------------------------------------------
# calibration-report
# ---------------------------------------------------------------------------

class ProbabilityPrediction(BaseModel):
    probabilityUp: float = Field(ge=0.0, le=1.0)
    outcome: int = Field(ge=0, le=1)


class QuantilePrediction(BaseModel):
    quantiles: Dict[str, float]
    realizedReturn: float


class CalibrationReportRequest(BaseModel):
    predictions: List[ProbabilityPrediction] = Field(default_factory=list)
    quantilePredictions: Optional[List[QuantilePrediction]] = None


class CalibrationReportResponse(BaseModel):
    brier: Optional[float] = None
    reliabilityBins: List[ReliabilityBin] = Field(default_factory=list)
    quantileCoverage: Optional[Dict[str, float]] = None
    sampleSize: int


# ---------------------------------------------------------------------------
# translate (Argos offline fallback; Part 2 translation agent)
# ---------------------------------------------------------------------------

class TranslateRequest(BaseModel):
    text: str
    # 'auto' = naive CJK detection server-side (zh vs en are the only shipped pairs)
    sourceLang: str = "auto"
    targetLang: str


class TranslateResponse(BaseModel):
    status: str
    # package_missing = argostranslate not installed or the language pair was
    # never downloaded; caller must degrade explicitly, never fabricate.
    error: Optional[str] = None
    text: Optional[str] = None
    detectedLang: Optional[str] = None
