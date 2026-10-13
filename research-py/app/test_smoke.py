"""Smoke test: python -m app.test_smoke

Exercises the fixed endpoints end-to-end via FastAPI's TestClient (in-process,
no uvicorn needed): synthetic train -> predict -> calibration-report, a
determinism re-train, and parse-document with a minimal PDF byte stream.

No pytest dependency; plain asserts, exits non-zero on failure.
"""

import base64
import os
import tempfile

import numpy as np
from fastapi.testclient import TestClient

from .main import app
from .parsing import docling_available

MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
    b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
    b"4 0 obj<</Length 44>>stream\n"
    b"BT /F1 12 Tf 72 720 Td (Hello smoke test) Tj ET\n"
    b"endstream\nendobj\n"
    b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)


def _synthetic_rows(n: int = 400, seed: int = 7):
    rng = np.random.default_rng(seed)
    x1 = rng.normal(0.0, 1.0, n)
    x2 = rng.normal(0.0, 1.0, n)
    x3 = rng.normal(0.0, 1.0, n)
    noise = rng.normal(0.0, 0.5, n)
    label = 0.5 * x1 - 0.3 * x2 + noise
    rows = []
    for i in range(n):
        if i < int(n * 0.6):
            split = "dev"
        elif i < int(n * 0.8):
            split = "calibration"
        else:
            split = "test"
        rows.append(
            {
                "features": {"x1": float(x1[i]), "x2": float(x2[i]), "x3": float(x3[i])},
                "labelReturn": float(label[i]),
                "split": split,
            }
        )
    return rows


def main() -> None:
    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200, health.text
    body = health.json()
    assert body["status"] == "ok" and isinstance(body["docling"], bool), body
    print(f"[smoke] /health ok: {body}")

    with tempfile.TemporaryDirectory(prefix="research-py-smoke-") as tmp:
        rows = _synthetic_rows()
        train_payload = {
            "modelVersion": "smoke-v1",
            "horizon": "1h",
            "featureVersion": "fv1",
            "rows": rows,
            "artifactDir": tmp,
        }
        resp = client.post("/tasks/train", json=train_payload)
        assert resp.status_code == 200, resp.text
        trained = resp.json()
        assert os.path.exists(trained["artifactPath"]), trained["artifactPath"]
        assert trained["trainedRows"] == 240, trained["trainedRows"]
        assert trained["featureNames"] == ["x1", "x2", "x3"], trained["featureNames"]
        for split in ("dev", "calibration", "test"):
            assert split in trained["metrics"]["splits"], trained["metrics"]
            assert "0.5" in trained["metrics"]["splits"][split]["coverage"]
        assert trained["calibrationReport"]["sampleSize"] == 80
        assert len(trained["calibrationReport"]["reliabilityBins"]) == 10
        # isotonic level-remap calibrator must be fit and persisted (publish gate)
        assert trained["calibrated"] is True, trained.get("calibrated")
        assert trained["calibrationRows"] == 80, trained["calibrationRows"]
        print("[smoke] /tasks/train ok, artifact:", trained["artifactPath"])

        # Determinism: identical input -> identical metrics.
        train_payload2 = dict(train_payload, modelVersion="smoke-v1-repeat")
        trained2 = client.post("/tasks/train", json=train_payload2).json()
        assert trained2["metrics"] == trained["metrics"], "metrics differ between identical runs"
        print("[smoke] determinism check ok")

        # Predict 10 rows: one with a missing feature, all with an extra key.
        pred_rows = []
        for i in range(10):
            feats = {"x1": float(i) * 0.1 - 0.5, "x2": 0.1 * i, "extraIgnored": 1.0}
            if i != 0:
                feats["x3"] = -0.1 * i
            pred_rows.append({"features": feats})
        resp = client.post(
            "/tasks/predict",
            json={"modelVersion": "smoke-v1", "rows": pred_rows, "artifactDir": tmp},
        )
        assert resp.status_code == 200, resp.text
        pred = resp.json()
        assert len(pred["predictions"]) == 10
        assert any("extraIgnored" in w for w in pred["warnings"]), pred["warnings"]
        for p in pred["predictions"]:
            assert 0.0 <= p["probabilityUp"] <= 1.0, p
            assert "0.05" in p["quantiles"] and "0.95" in p["quantiles"], p
            # calibrated grid present and covers the same value span as nominal
            assert p["calibratedQuantiles"], p
            assert min(p["calibratedQuantiles"].values()) == min(p["quantiles"].values()), p
            assert max(p["calibratedQuantiles"].values()) == max(p["quantiles"].values()), p
        # artifact-bound calibration metadata: absent mapping must not publish
        assert pred["calibration"] and pred["calibration"]["kind"] == "isotonic", pred.get("calibration")
        assert pred["calibration"]["calRows"] == 80, pred["calibration"]
        print("[smoke] /tasks/predict ok, warnings:", pred["warnings"])

        missing = client.post(
            "/tasks/predict",
            json={"modelVersion": "does-not-exist", "rows": [{"features": {}}], "artifactDir": tmp},
        )
        assert missing.status_code == 404, missing.text
        print("[smoke] missing artifact -> 404 ok")

        # calibration-report from the predictions we just made.
        rng = np.random.default_rng(11)
        cal_payload = {
            "predictions": [
                {
                    "probabilityUp": p["probabilityUp"],
                    "outcome": int(rng.random() < p["probabilityUp"]),
                }
                for p in pred["predictions"]
            ],
            "quantilePredictions": [
                {
                    "quantiles": p["quantiles"],
                    "realizedReturn": float(rng.normal(0.0, 1.0)),
                }
                for p in pred["predictions"]
            ],
        }
        resp = client.post("/tasks/calibration-report", json=cal_payload)
        assert resp.status_code == 200, resp.text
        cal = resp.json()
        assert cal["sampleSize"] == 10, cal
        assert cal["brier"] is not None and 0.0 <= cal["brier"] <= 1.0, cal
        assert len(cal["reliabilityBins"]) == 10
        assert cal["quantileCoverage"] and "0.5" in cal["quantileCoverage"], cal
        print("[smoke] /tasks/calibration-report ok")

    # parse-document with a minimal PDF byte stream.
    resp = client.post(
        "/tasks/parse-document",
        json={
            "docId": "smoke-doc-1",
            "fileName": "smoke.pdf",
            "contentBase64": base64.b64encode(MINIMAL_PDF).decode("ascii"),
        },
    )
    assert resp.status_code == 200, resp.text
    parsed = resp.json()
    if docling_available():
        assert parsed["status"] == "ok", parsed
        assert len(parsed["blocks"]) > 0, parsed
        print(f"[smoke] parse-document ok with docling: {len(parsed['blocks'])} blocks")
    else:
        assert parsed["status"] == "failed" and parsed["error"], parsed
        print(f"[smoke] parse-document failed path ok (docling unavailable): {parsed['error']}")

    # unsupported type must fail cleanly even without docling
    resp = client.post(
        "/tasks/parse-document",
        json={"docId": "smoke-doc-2", "fileName": "notes.txt", "contentBase64": "aGVsbG8="},
    )
    assert resp.status_code == 200 and resp.json()["status"] == "failed", resp.text
    print("[smoke] unsupported file type -> failed ok")

    print("[smoke] ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
