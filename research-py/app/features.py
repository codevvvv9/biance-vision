"""Feature matrix assembly: ordered dict rows -> numpy float64 matrix.

The Node side computes features from frozen snapshots and passes them as plain
dicts; this module is the single place that fixes the column order.
"""

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


def fit_feature_names(rows: Sequence[Dict[str, float]]) -> List[str]:
    """Deterministic column order for training: sorted union of all keys."""
    names = set()
    for row in rows:
        names.update(row.keys())
    return sorted(names)


def assemble_matrix(
    rows: Sequence[Dict[str, float]],
    feature_names: Optional[List[str]] = None,
) -> Tuple[np.ndarray, List[str], List[str]]:
    """Build an (n_rows, n_features) float64 matrix.

    - fit mode (feature_names=None): names come from fit_feature_names(rows).
    - predict mode: columns follow the stored feature_names; missing columns
      are filled with NaN (HistGradientBoosting handles NaN natively); extra
      keys are ignored and reported in the returned warnings list.
    """
    warnings: List[str] = []
    if feature_names is None:
        feature_names = fit_feature_names(rows)
    else:
        extra = sorted({k for row in rows for k in row.keys()} - set(feature_names))
        if extra:
            warnings.append(f"extra features ignored: {', '.join(extra)}")

    n = len(rows)
    m = len(feature_names)
    X = np.full((n, m), np.nan, dtype=np.float64)
    for j, name in enumerate(feature_names):
        for i, row in enumerate(rows):
            value = row.get(name)
            if value is not None:
                X[i, j] = value
    return X, feature_names, warnings
