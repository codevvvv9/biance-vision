"""Quantile GBM training / inference / calibration reporting.

Design notes:
- One model per quantile level. Preferred backend is sklearn's modern
  HistGradientBoostingRegressor(loss="quantile", quantile=q) (sklearn >= 1.1,
  handles NaN natively); on older sklearn we fall back to
  GradientBoostingRegressor(loss="quantile", alpha=q) with median imputation
  for NaN (the fallback backend does not accept NaN).
- random_state is pinned to 42 everywhere so identical inputs produce
  identical metrics.
- Time discipline: this service never makes time-splitting decisions. The
  caller (Node worker) assigns each row its dev/calibration/test split; we
  only train on dev, calibrate on calibration, and evaluate on test.
- probabilityUp is derived from the quantile CDF at 0 by linear interpolation
  between adjacent quantiles: P(up) = 1 - CDF_q(0).
"""

import os
import time
from typing import Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression

from .features import assemble_matrix
from .schemas import (
    CalibrationMeta,
    CalibrationReport,
    CalibrationReportRequest,
    CalibrationReportResponse,
    PredictRequest,
    PredictResponse,
    PredictionOut,
    ProbabilityReport,
    ReliabilityBin,
    SplitMetrics,
    TrainMetrics,
    TrainRequest,
    TrainResponse,
)

RANDOM_STATE = 42
N_RELIABILITY_BINS = 10


class ArtifactNotFound(FileNotFoundError):
    pass


def _quantile_key(q: float) -> str:
    """Stable string key matching the Node contract style ("0.05", "0.1", ...)."""
    return f"{q:g}"


def _model_dir(artifact_dir: Optional[str]) -> str:
    return artifact_dir or os.environ.get("MODEL_DIR", "./data/models")


def _artifact_path(model_version: str, artifact_dir: Optional[str]) -> str:
    if os.sep in model_version or ".." in model_version or model_version != os.path.basename(model_version):
        raise ValueError(f"invalid modelVersion for artifact path: {model_version!r}")
    return os.path.join(_model_dir(artifact_dir), f"{model_version}.joblib")


def _new_quantile_model(q: float):
    """Return (estimator, backend). backend in {"hist", "gbr"}."""
    try:
        from sklearn.ensemble import HistGradientBoostingRegressor

        return (
            HistGradientBoostingRegressor(loss="quantile", quantile=q, random_state=RANDOM_STATE),
            "hist",
        )
    except (TypeError, ValueError):  # sklearn < 1.1: no quantile loss on HistGB
        from sklearn.ensemble import GradientBoostingRegressor

        return (
            GradientBoostingRegressor(loss="quantile", alpha=q, random_state=RANDOM_STATE),
            "gbr",
        )


def _enforce_monotone(values: np.ndarray) -> np.ndarray:
    """Quantile predictions can cross; force a non-decreasing sequence."""
    return np.maximum.accumulate(np.asarray(values, dtype=np.float64))


def probability_up_from_quantiles(quantile_levels: Sequence[float], values: Sequence[float]) -> Tuple[float, bool]:
    """P(up) = 1 - CDF_q(0), CDF piecewise-linear between adjacent quantiles.

    Returns (probability, degenerate). degenerate=True when 0 is not bracketed
    by the predicted quantile range and the probability was clamped to the
    nearest boundary instead of interpolated.
    """
    vs = _enforce_monotone(np.asarray(values, dtype=np.float64))
    qs = np.asarray(quantile_levels, dtype=np.float64)
    if 0.0 < vs[0]:
        return 1.0, True
    if 0.0 > vs[-1]:
        return 0.0, True
    # Collapse duplicate values, keeping the largest level (right-continuous CDF).
    uniq_v: List[float] = []
    uniq_q: List[float] = []
    for v, q in zip(vs.tolist(), qs.tolist()):
        if uniq_v and v == uniq_v[-1]:
            uniq_q[-1] = q
        else:
            uniq_v.append(v)
            uniq_q.append(q)
    if len(uniq_v) == 1:
        cdf0 = uniq_q[0]
    else:
        cdf0 = float(np.interp(0.0, uniq_v, uniq_q))
    p = 1.0 - cdf0
    return float(min(max(p, 0.0), 1.0)), False


def brier_score(probs: np.ndarray, outcomes: np.ndarray) -> Optional[float]:
    if len(probs) == 0:
        return None
    return float(np.mean((probs - outcomes) ** 2))


def reliability_bins(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = N_RELIABILITY_BINS) -> List[ReliabilityBin]:
    bins: List[ReliabilityBin] = []
    for i in range(n_bins):
        lo, hi = i / n_bins, (i + 1) / n_bins
        if i < n_bins - 1:
            mask = (probs >= lo) & (probs < hi)
        else:
            mask = (probs >= lo) & (probs <= hi)
        count = int(mask.sum())
        bins.append(
            ReliabilityBin(
                bin=f"{lo:.1f}-{hi:.1f}",
                avgPred=float(probs[mask].mean()) if count else None,
                freq=float(outcomes[mask].mean()) if count else None,
                count=count,
            )
        )
    return bins


def quantile_coverage(quantile_levels: Sequence[float], preds: np.ndarray, realized: np.ndarray) -> Dict[str, float]:
    """preds: (n, n_quantiles) predicted values; realized: (n,) labels."""
    out: Dict[str, float] = {}
    for j, q in enumerate(quantile_levels):
        out[_quantile_key(q)] = float(np.mean(realized <= preds[:, j]))
    return out


def _split_masks(splits: Sequence[str]) -> Dict[str, np.ndarray]:
    arr = np.asarray(splits)
    return {name: arr == name for name in ("dev", "calibration", "test")}


def _fit_level_calibrator(
    levels: Sequence[float], preds_cal: np.ndarray, y_cal: np.ndarray
) -> Optional[Dict]:
    """Fit an isotonic map nominal quantile level -> empirical coverage on the
    calibration split (distribution calibration). Inference then interpolates
    probabilities on the remapped grid, so EV/three-way probabilities go
    through the same mapping, not just the threshold-0 direction probability.

    Returns the calibrator dict persisted inside the artifact, or None when the
    calibration split has fewer than 2 rows (mapping cannot be fit).
    """
    if preds_cal.shape[0] < 2:
        return None
    levels_arr = np.asarray(levels, dtype=np.float64)
    empirical = np.asarray(
        [float(np.mean(y_cal <= preds_cal[:, j])) for j in range(len(levels_arr))],
        dtype=np.float64,
    )
    iso = IsotonicRegression(increasing=True, out_of_bounds="clip")
    iso.fit(levels_arr, empirical)
    return {
        "kind": "isotonic",
        "model": iso,
        "calRows": int(preds_cal.shape[0]),
        "nominal": levels_arr.tolist(),
        "empirical": empirical.tolist(),
    }


def _calibrated_levels(calibrator: Optional[Dict], levels: Sequence[float]) -> np.ndarray:
    """Remap nominal quantile levels through the fitted calibrator (clip to [0, 1])."""
    if calibrator is None:
        return np.asarray(levels, dtype=np.float64)
    mapped = np.asarray(calibrator["model"].predict(np.asarray(levels, dtype=np.float64)), dtype=np.float64)
    return np.clip(mapped, 0.0, 1.0)


def train(req: TrainRequest) -> TrainResponse:
    splits = [row.split for row in req.rows]
    masks = _split_masks(splits)
    if not masks["dev"].any():
        raise ValueError("no dev rows provided; training requires at least one dev row")

    X_all, feature_names, _ = assemble_matrix([row.features for row in req.rows])
    X_all = np.where(np.isinf(X_all), np.nan, X_all)
    y_all = np.asarray([row.labelReturn for row in req.rows], dtype=np.float64)
    if not np.all(np.isfinite(y_all)):
        raise ValueError("labelReturn must be finite for all rows")

    quantiles = req.quantiles or [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]

    X_dev = X_all[masks["dev"]]
    y_dev = y_all[masks["dev"]]

    # Fallback backend (gbr) cannot consume NaN: impute with dev column medians.
    fill_values: Optional[List[float]] = None
    models = {}
    backend = "hist"
    for q in quantiles:
        model, backend = _new_quantile_model(q)
        if backend == "gbr" and fill_values is None:
            med = np.nanmedian(X_dev, axis=0)
            med = np.where(np.isnan(med), 0.0, med)
            fill_values = med.tolist()
        X_fit = X_dev
        if backend == "gbr":
            X_fit = np.where(np.isnan(X_dev), np.asarray(fill_values), X_dev)
        model.fit(X_fit, y_dev)
        models[_quantile_key(q)] = model

    def _predict_matrix(mask: np.ndarray) -> np.ndarray:
        X = X_all[mask]
        if backend == "gbr":
            X = np.where(np.isnan(X), np.asarray(fill_values), X)
        cols = [models[_quantile_key(q)].predict(X) for q in quantiles]
        # Enforce monotonicity across quantiles per row.
        return np.maximum.accumulate(np.column_stack(cols), axis=1) if cols else np.empty((int(mask.sum()), 0))

    # Distribution calibration (isotonic level remap) fit on the calibration
    # split: nominal level -> empirical P(realized <= predicted quantile).
    # Applied to every downstream probability so published models always
    # carry an explicit, verifiable calibration mapping.
    calibrator: Optional[Dict] = None
    if int(masks["calibration"].sum()) > 0:
        calibrator = _fit_level_calibrator(
            quantiles, _predict_matrix(masks["calibration"]), y_all[masks["calibration"]]
        )
    calibrated_qs = _calibrated_levels(calibrator, quantiles)

    split_metrics: Dict[str, SplitMetrics] = {}
    sample_sizes: Dict[str, int] = {}
    calibration_report = CalibrationReport()

    for name in ("dev", "calibration", "test"):
        mask = masks[name]
        n = int(mask.sum())
        sample_sizes[name] = n
        if n == 0:
            continue
        preds = _predict_matrix(mask)
        y = y_all[mask]
        coverage = quantile_coverage(quantiles, preds, y)
        prob_report: Optional[ProbabilityReport] = None
        if name in ("calibration", "test"):
            probs = np.asarray(
                [probability_up_from_quantiles(calibrated_qs, preds[i])[0] for i in range(n)],
                dtype=np.float64,
            )
            outcomes = (y > 0.0).astype(np.float64)
            prob_report = ProbabilityReport(
                brier=brier_score(probs, outcomes),
                reliabilityBins=reliability_bins(probs, outcomes),
                sampleSize=n,
            )
            if name == "calibration":
                calibration_report = CalibrationReport(
                    brier=prob_report.brier,
                    reliabilityBins=prob_report.reliabilityBins,
                    quantileCoverage=coverage,
                    sampleSize=n,
                )
        split_metrics[name] = SplitMetrics(coverage=coverage, probabilityUp=prob_report, sampleSize=n)

    path = _artifact_path(req.modelVersion, req.artifactDir)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    joblib.dump(
        {
            "quantiles": quantiles,
            "models": models,
            "featureNames": feature_names,
            "horizon": req.horizon,
            "featureVersion": req.featureVersion,
            "trainedAt": int(time.time()),
            "backend": backend,
            "fillValues": fill_values,
            "calibrator": calibrator,
        },
        path,
    )

    return TrainResponse(
        modelVersion=req.modelVersion,
        artifactPath=os.path.abspath(path),
        metrics=TrainMetrics(splits=split_metrics, sampleSize=sample_sizes),
        featureNames=feature_names,
        trainedRows=int(masks["dev"].sum()),
        calibrationReport=calibration_report,
        calibrated=calibrator is not None,
        calibrationRows=int(calibrator["calRows"]) if calibrator is not None else 0,
    )


def load_artifact(model_version: str, artifact_dir: Optional[str]):
    path = _artifact_path(model_version, artifact_dir)
    if not os.path.exists(path):
        raise ArtifactNotFound(f"model artifact not found: {model_version}")
    artifact = joblib.load(path)
    for key in ("quantiles", "models", "featureNames"):
        if key not in artifact:
            raise ValueError(f"artifact {model_version} missing key {key!r}")
    return artifact, path


def predict(req: PredictRequest) -> PredictResponse:
    artifact, _ = load_artifact(req.modelVersion, req.artifactDir)
    quantiles: List[float] = list(artifact["quantiles"])
    feature_names: List[str] = list(artifact["featureNames"])
    backend = artifact.get("backend", "hist")
    fill_values = artifact.get("fillValues")
    calibrator = artifact.get("calibrator")
    calibrated_qs = _calibrated_levels(calibrator, quantiles)

    X, _, warnings = assemble_matrix([row.features for row in req.rows], feature_names=feature_names)
    X = np.where(np.isinf(X), np.nan, X)
    # Columns missing from every row are all-NaN; HistGB treats NaN as a proper
    # missing value, the gbr fallback uses stored dev medians.
    if backend == "gbr":
        X = np.where(np.isnan(X), np.asarray(fill_values), X)

    models = artifact["models"]
    cols = [models[_quantile_key(q)].predict(X) for q in quantiles]
    preds = np.maximum.accumulate(np.column_stack(cols), axis=1)

    out: List[PredictionOut] = []
    for i in range(X.shape[0]):
        values = preds[i]
        # Probabilities interpolate on the calibrated grid (isotonic level
        # remap): EV / three-way / direction probabilities all pass through it.
        prob, degenerate = probability_up_from_quantiles(calibrated_qs, values)
        out.append(
            PredictionOut(
                quantiles={_quantile_key(q): float(v) for q, v in zip(quantiles, values)},
                calibratedQuantiles={
                    _quantile_key(q): float(v) for q, v in zip(calibrated_qs, values)
                },
                probabilityUp=prob,
                degenerate=degenerate,
            )
        )
    return PredictResponse(
        modelVersion=req.modelVersion,
        featureNames=feature_names,
        predictions=out,
        warnings=warnings,
        calibration=CalibrationMeta(kind=calibrator["kind"], calRows=int(calibrator["calRows"]))
        if calibrator is not None
        else None,
    )


def calibration_report(req: CalibrationReportRequest) -> CalibrationReportResponse:
    probs = np.asarray([p.probabilityUp for p in req.predictions], dtype=np.float64)
    outcomes = np.asarray([p.outcome for p in req.predictions], dtype=np.float64)

    coverage: Optional[Dict[str, float]] = None
    if req.quantilePredictions:
        # Levels come from the quantiles dict keys; sorted numerically for
        # determinism regardless of caller ordering.
        levels = sorted(float(k) for k in req.quantilePredictions[0].quantiles.keys())
        keys = [_quantile_key(q) for q in levels]
        realized = np.asarray([qp.realizedReturn for qp in req.quantilePredictions], dtype=np.float64)
        pred_matrix = np.asarray(
            [[qp.quantiles[_quantile_key(q)] for q in levels] for qp in req.quantilePredictions],
            dtype=np.float64,
        )
        coverage = quantile_coverage(levels, pred_matrix, realized)
        _ = keys  # keys kept for readability of the mapping above

    return CalibrationReportResponse(
        brier=brier_score(probs, outcomes),
        reliabilityBins=reliability_bins(probs, outcomes),
        quantileCoverage=coverage,
        sampleSize=len(req.predictions),
    )
