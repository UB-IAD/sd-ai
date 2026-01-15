# Time Series Behavior Analysis

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Try%20It%20Now-blue?style=for-the-badge)](https://app.veydra.io/tools/behavior-analysis)

A fast, statistically-principled time series shape classifier using AICc-based model selection.

Developed and open sourced in partnership with **BEAMS** and the **University at Buffalo**.

## Live Demo

Try the interactive tool at **[app.veydra.io/tools/behavior-analysis](https://app.veydra.io/tools/behavior-analysis)**:

- **Synthetic Data Mode**: Generate preset patterns (exponential, S-curve, oscillating, etc.) and see instant classification
- **Upload Your Data**: Drag & drop CSV files with time series data for multi-variable analysis
- **Real-time Results**: View confidence scores, shape statistics, and direction detection
- **No Installation**: Runs entirely in-browser using Pyodide (Python compiled to WebAssembly)

## Overview

This module classifies the behavioral shape of a 1D time series into intuitive categories like "s_curve_growth", "exponential_decay", "step_up", "inactive", etc. It uses **Akaike Information Criterion with small-sample correction (AICc)** to select the best-fitting model from a family of candidate shapes.

## Quick Start

```python
import numpy as np
from time_series_behavior_analysis import classify_timeseries_shape_and_scale

# Example: S-curve adoption pattern
t = np.arange(300)
y = 1 / (1 + np.exp(-0.06 * (t - 140))) + 0.03 * np.random.randn(len(t))

result = classify_timeseries_shape_and_scale(y)

print(result["shape"]["best_label"])  # "s_curve_growth"
print(result["shape"]["direction"])   # "increasing"
print(result["scale"]["delta"])       # ~1.0 (change from start to end)
```

## Detected Patterns

| Category | Labels | Description |
|----------|--------|-------------|
| **Stable** | `stable` | Constant, no trend |
| **Inactive** | `inactive` | Constant near zero (no activity) |
| **Linear** | `linear_growth`, `linear_decline`, `linear_flat` | Straight-line trends |
| **Accelerating** | `accelerating_growth`, `accelerating_decline` | Quadratic curves (speeding up) |
| **Inflecting** | `inflecting_growth`, `inflecting_decline` | Cubic curves (changing acceleration) |
| **Exponential** | `exponential_growth`, `exponential_decline` | Exponential rise or decay |
| **S-Curve** | `s_curve_growth`, `s_curve_decline` | Logistic/sigmoid adoption curves |
| **Peak** | `peak` | Rises then falls (bump up) |
| **Dip** | `dip` | Falls then rises (bump down) |
| **Step** | `step_up`, `step_down` | Sudden level change |
| **Oscillating** | `oscillating`, `oscillating_trending_up`, `oscillating_trending_down` | Periodic wave patterns |
| **Dampening** | `dampening`, `dampening_trending_up`, `dampening_trending_down` | Decaying oscillations |
| **Overshoot** | `overshoot_up`, `overshoot_down` | Step response with overshoot then settling |

## Output Structure

```python
{
    "shape": {
        "best_label": "s_curve_growth",      # Full label with direction
        "base_shape": "s_curve",             # Shape category without direction
        "direction": "increasing",           # "increasing", "decreasing", or "stable"
        "probabilities": {...},              # Model weights (sum to 1.0)
        "scores_aicc": {...},                # Raw AICc scores (lower = better)
        "normalized_series": [...],          # Resampled, normalized data
        "shape_rmse": 0.15,                  # Fit quality (lower = better)
        "possibly_complex_or_unmodeled": False,
        "normalization": "zscore",
        "n_resample": 120
    },
    "scale": {
        "mean": 0.52,
        "std": 0.28,
        "min": 0.01,
        "max": 1.02,
        "range": 1.01,
        "start_value": 0.03,                 # Average of first 10%
        "end_value": 0.98,                   # Average of last 10%
        "delta": 0.95,                       # end - start
        "delta_percent": 3166.67,            # Percent change (if start != 0)
        # Monotonicity detection
        "is_monotonic_increasing": True,     # Never decreases
        "is_monotonic_decreasing": False,    # Never increases
        "is_strictly_monotonic": True,       # Always strictly changes (no flat sections)
        # Correlation with time
        "correlation_with_time": 0.95,       # Pearson r: 1 = perfect positive linear
        "r_squared": 0.92                    # R² of linear fit: 1 = perfectly linear
    }
}
```

## Technical Approach

### Model Selection via AICc

The classifier fits multiple candidate models to the (resampled, normalized) time series and selects the best using **AICc**:

```
AIC = n * ln(SSE/n) + 2k
AICc = AIC + (2k² + 2k) / (n - k - 1)
```

Where:
- `n` = number of data points
- `k` = number of model parameters
- `SSE` = sum of squared errors

AICc balances fit quality against model complexity, with extra penalty for small samples.

### Candidate Models

| Model | Formula | Parameters |
|-------|---------|------------|
| Stable | `y = c` | 1 |
| Linear | `y = ax + b` | 2 |
| Accelerating | `y = ax² + bx + c` | 3 |
| Inflecting | `y = ax³ + bx² + cx + d` | 4 |
| Exponential | `y = A·exp(bx) + C` | 3 |
| S-Curve | `y = A / (1 + exp(-k(x-x₀))) + C` | 4 |
| Bump | `y = A·exp(-(x-μ)²/(2σ²)) + C` | 4 |
| Step | `y = A·σ(s(x-t)) + Bx + C` | 4-5 |
| Oscillating | `y = A·sin(2πfx + φ) + C` | 4 |
| Dampening | `y = A·exp(-dx)·sin(2πfx + φ) + C` | 5 |
| Overshoot | `y = A·(1 - exp(-x/τ)·(cos(ωx) + sin(ωx)/(ωτ))) + C` | 4 |

### Efficient Fitting

Non-linear models use a **grid search + linear inner solve** approach:
1. Grid over non-linear parameters (e.g., rate, midpoint)
2. Solve linear parameters via OLS for each grid point
3. Select configuration with minimum SSE

This avoids iterative optimization while maintaining good fit quality.

## Parameters

```python
classify_timeseries_shape_and_scale(
    y,                      # Input time series (1D array-like)
    n_resample=120,         # Resample to this length (default: 120)
    normalize="zscore",     # "zscore" or "minmax"
    max_freq_cycles=5       # Max oscillation frequency to detect
)
```

## Special Cases

### Near-Zero Detection (`inactive`)
When a series is classified as `stable` and its mean is near zero relative to its range, it's relabeled as `inactive`. This distinguishes:
- `stable` → constant at some value (e.g., steady state)
- `inactive` → constant at/near zero (e.g., system off, no activity)

### Monotonicity & Time Correlation
The output includes flags for detecting if a series is perfectly correlated with time:

| Field | Description |
|-------|-------------|
| `is_monotonic_increasing` | True if series never decreases (y[i+1] >= y[i]) |
| `is_monotonic_decreasing` | True if series never increases (y[i+1] <= y[i]) |
| `is_strictly_monotonic` | True if series always changes (no flat sections) |
| `correlation_with_time` | Pearson r: 1.0 = perfect positive linear, -1.0 = perfect negative |
| `r_squared` | R² of linear fit: 1.0 = perfectly linear |

Example use cases:
- **Cumulative metrics** (always increasing): `is_monotonic_increasing = True`
- **Counter that correlates with time**: `correlation_with_time ≈ 1.0` and `r_squared ≈ 1.0`
- **Decay process**: `is_monotonic_decreasing = True`, `correlation_with_time < -0.9`

### Direction Suffixes
- Trend shapes: `_growth`, `_decline`, `_flat`
- Step changes: `_up`, `_down`
- Oscillations with trend: `_trending_up`, `_trending_down`
- Overshoot: `_up` (overshoots high), `_down` (overshoots low)

## Requirements

- Python 3.8+
- NumPy

## Testing

```bash
python -m pytest time_series_behavior_analysis -v
```

81 tests covering all models, edge cases, and direction detection.
