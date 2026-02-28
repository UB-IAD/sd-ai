import numpy as np
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


def _nan_interp(y: np.ndarray) -> np.ndarray:
    """Linearly interpolate NaNs; if all NaN, raise."""
    y = np.asarray(y, dtype=float)
    n = y.size
    if n == 0:
        raise ValueError("Empty time series.")
    mask = np.isfinite(y)
    if not mask.any():
        raise ValueError("Time series contains no finite values.")
    if mask.all():
        return y
    x = np.arange(n, dtype=float)
    y2 = y.copy()
    y2[~mask] = np.interp(x[~mask], x[mask], y[mask])
    return y2


def _resample_to_n(y: np.ndarray, n: int) -> np.ndarray:
    """Resample arbitrary-length series to length n using linear interpolation."""
    y = np.asarray(y, dtype=float)
    if y.size == n:
        return y
    x_old = np.linspace(0.0, 1.0, y.size)
    x_new = np.linspace(0.0, 1.0, n)
    return np.interp(x_new, x_old, y)


def _zscore(y: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    mu = float(np.mean(y))
    sd = float(np.std(y))
    if sd < eps:
        return (y - mu)  # all ~constant
    return (y - mu) / sd


def _aic_from_sse(sse: float, n: int, k: int, eps: float = 1e-12) -> float:
    """Gaussian AIC using SSE; k = number of free parameters."""
    sse = float(max(sse, eps))
    # -2 log L up to constants: n * ln(SSE/n)
    return n * np.log(sse / n) + 2 * k


def _aicc(aic: float, n: int, k: int) -> float:
    """Small-sample correction; safe when n > k+1."""
    if n <= (k + 1):
        return aic + 1e6  # heavy penalty if over-parameterized
    return aic + (2 * k * (k + 1)) / (n - k - 1)


def _weights_from_scores(scores: Dict[str, float]) -> Dict[str, float]:
    """Convert AIC/AICc/BIC-like scores to probability-like weights."""
    items = list(scores.items())
    vals = np.array([v for _, v in items], dtype=float)
    m = float(np.min(vals))
    w = np.exp(-(vals - m) / 2.0)
    w_sum = float(np.sum(w))
    w = w / (w_sum if w_sum > 0 else 1.0)
    return {items[i][0]: float(w[i]) for i in range(len(items))}


def _ols_fit(design: np.ndarray, y: np.ndarray) -> Tuple[np.ndarray, float]:
    """
    Ordinary least squares fit.
    Returns (beta, sse).
    """
    beta, *_ = np.linalg.lstsq(design, y, rcond=None)
    resid = y - design @ beta
    sse = float(np.sum(resid * resid))
    return beta, sse


def _poly_model(x: np.ndarray, y: np.ndarray, deg: int) -> Tuple[float, int]:
    # y = b0 + b1 x + ... + bdeg x^deg
    X = np.vstack([x**d for d in range(deg + 1)]).T
    _, sse = _ols_fit(X, y)
    k = deg + 1
    return sse, k


def _exp_model(y: np.ndarray, x: np.ndarray, b_grid: np.ndarray) -> Tuple[float, int]:
    """
    y = A * exp(b x) + C
    For fixed b, solve A, C linearly.
    """
    best = (np.inf, 2)
    for b in b_grid:
        f = np.exp(b * x)
        X = np.column_stack([f, np.ones_like(x)])
        _, sse = _ols_fit(X, y)
        if sse < best[0]:
            best = (sse, 3)  # A, b, C (b is selected via grid)
    return best


def _logistic_model(y: np.ndarray, x: np.ndarray, k_grid: np.ndarray, x0_grid: np.ndarray) -> Tuple[float, int]:
    """
    y = A * s(x; k, x0) + C, where s = 1/(1+exp(-k(x-x0))).
    For fixed k, x0, solve A, C linearly.
    """
    best = (np.inf, 4)  # A, k, x0, C
    for k in k_grid:
        for x0 in x0_grid:
            s = 1.0 / (1.0 + np.exp(-k * (x - x0)))
            X = np.column_stack([s, np.ones_like(x)])
            _, sse = _ols_fit(X, y)
            if sse < best[0]:
                best = (sse, 4)
    return best


def _gaussian_bump(y: np.ndarray, x: np.ndarray, mu_grid: np.ndarray, sig_grid: np.ndarray) -> Tuple[float, int]:
    """
    y = A * exp(-0.5*((x-mu)/sig)^2) + C
    For fixed mu,sig solve A,C linearly.
    """
    best = (np.inf, 4)  # A, mu, sig, C
    for mu in mu_grid:
        for sig in sig_grid:
            g = np.exp(-0.5 * ((x - mu) / sig) ** 2)
            X = np.column_stack([g, np.ones_like(x)])
            _, sse = _ols_fit(X, y)
            if sse < best[0]:
                best = (sse, 4)
    return best


def _step_change(y: np.ndarray, x: np.ndarray, t_grid: np.ndarray, allow_trend: bool = True) -> Tuple[float, int]:
    """
    y = A * I(x>=t) + C [+ B x]
    """
    best_sse = np.inf
    best_k = 0
    for t in t_grid:
        h = (x >= t).astype(float)
        cols = [h, np.ones_like(x)]
        k = 3  # A, t, C (t via grid)
        if allow_trend:
            cols.insert(0, x)
            k = 4  # B, A, t, C
        X = np.column_stack(cols)
        _, sse = _ols_fit(X, y)
        if sse < best_sse:
            best_sse = sse
            best_k = k
    return best_sse, best_k


def _sine_model(y: np.ndarray, x: np.ndarray, f_grid: np.ndarray) -> Tuple[float, int]:
    """
    y = a*sin(2π f x) + b*cos(2π f x) + C
    """
    best = (np.inf, 4)  # a,b,f,C  (f via grid)
    twopi = 2.0 * np.pi
    for f in f_grid:
        s = np.sin(twopi * f * x)
        c = np.cos(twopi * f * x)
        X = np.column_stack([s, c, np.ones_like(x)])
        _, sse = _ols_fit(X, y)
        if sse < best[0]:
            best = (sse, 4)
    return best


def _damped_sine_model(y: np.ndarray, x: np.ndarray, f_grid: np.ndarray, d_grid: np.ndarray) -> Tuple[float, int]:
    """
    y = exp(-d x) * (a*sin(2π f x) + b*cos(2π f x)) + C
    """
    best = (np.inf, 5)  # a,b,f,d,C  (f,d via grid)
    twopi = 2.0 * np.pi
    for d in d_grid:
        env = np.exp(-d * x)
        for f in f_grid:
            s = env * np.sin(twopi * f * x)
            c = env * np.cos(twopi * f * x)
            X = np.column_stack([s, c, np.ones_like(x)])
            _, sse = _ols_fit(X, y)
            if sse < best[0]:
                best = (sse, 5)
    return best


def _overshoot_model(y: np.ndarray, x: np.ndarray, peak_pos_grid: np.ndarray, decay_rate_grid: np.ndarray, steady_state_grid: np.ndarray) -> Tuple[float, int]:
    """
    Climate overshoot model: S-curve rise to peak, then exponential decay to steady state.
    This matches the generator: piecewise with smooth rise and decay to non-zero steady state.
    For fixed peak_pos, decay_rate, steady_frac, solve amplitude and intercept linearly.
    """
    best = (np.inf, 6)  # peak_pos, decay_rate, steady_frac, amplitude, intercept + complexity penalty
    n = len(x)
    for peak_pos in peak_pos_grid:
        for decay_rate in decay_rate_grid:
            for steady_frac in steady_state_grid:
                # Build piecewise basis
                basis = np.zeros(n)
                for i, xi in enumerate(x):
                    if xi <= peak_pos:
                        # Rising phase: smoothstep (S-curve) from 0 to 1
                        t = xi / peak_pos
                        basis[i] = t * t * (3 - 2 * t)  # smoothstep
                    else:
                        # Decay phase: exponential decay from 1 to steady_frac
                        decay_progress = xi - peak_pos
                        decay_amount = (1 - steady_frac) * np.exp(-decay_rate * decay_progress)
                        basis[i] = steady_frac + decay_amount
                X = np.column_stack([basis, np.ones_like(x)])
                _, sse = _ols_fit(X, y)
                if sse < best[0]:
                    best = (sse, 6)
    return best


def classify_timeseries_shape_and_scale(
    ts: List[float],
    n_resample: int = 200,
    normalize: str = "zscore",
    max_freq_cycles: int = 6,
) -> Dict[str, Any]:
    """
    Classify a time series by *shape after normalization* and return scale metadata.

    Output:
      - shape.best_label
      - shape.probabilities (AICc weights across candidate shape families)
      - shape.scores (AICc per label; lower is better)
      - shape.normalized_series (length n_resample)
      - scale metadata (original units): mean, std, min, max, range, cv, slope, etc.

    Notes:
      - This is a statistical model-selection approach (not rule-based).
      - Probabilities are "probability-like" Akaike weights derived from AICc.
    """
    y_raw = _nan_interp(np.asarray(ts, dtype=float))
    n0 = int(y_raw.size)
    if n0 < 5:
        raise ValueError("Time series is too short; need at least ~5 points.")

    # --- scale metadata (computed on original series) ---
    x0 = np.arange(n0, dtype=float)
    X_lin = np.column_stack([x0, np.ones_like(x0)])
    beta_lin, sse_lin = _ols_fit(X_lin, y_raw)
    slope_raw = float(beta_lin[0])
    intercept_raw = float(beta_lin[1])

    diffs = np.diff(y_raw)
    
    # Monotonicity detection
    is_monotonic_increasing = bool(np.all(diffs >= 0))
    is_monotonic_decreasing = bool(np.all(diffs <= 0))
    is_strictly_monotonic_increasing = bool(np.all(diffs > 0))
    is_strictly_monotonic_decreasing = bool(np.all(diffs < 0))
    
    # Correlation with time (Pearson correlation coefficient)
    # r = 1 means perfectly linear increasing, r = -1 means perfectly linear decreasing
    if n0 > 1 and np.std(y_raw) > 1e-12:
        correlation_with_time = float(np.corrcoef(x0, y_raw)[0, 1])
    else:
        correlation_with_time = 0.0
    
    # R² for linear fit (coefficient of determination)
    ss_tot = float(np.sum((y_raw - np.mean(y_raw)) ** 2))
    r_squared = 1.0 - (sse_lin / (ss_tot + 1e-12)) if ss_tot > 1e-12 else 1.0
    
    # Start/end values (use average of first/last few points for robustness)
    n_edge = max(1, min(5, n0 // 10))  # Use 10% of points or at least 1, max 5
    start_value = float(np.mean(y_raw[:n_edge]))
    end_value = float(np.mean(y_raw[-n_edge:]))
    delta = end_value - start_value
    
    # Direction classification based on overall trend
    # Use relative threshold based on range to determine if change is significant
    range_val = float(np.max(y_raw) - np.min(y_raw))
    relative_delta = delta / (range_val + 1e-12)
    
    if abs(relative_delta) < 0.1:  # Less than 10% of range = stable
        direction = "stable"
    elif delta > 0:
        direction = "increasing"
    else:
        direction = "decreasing"
    
    scale = {
        "n_points": n0,
        "mean": float(np.mean(y_raw)),
        "std": float(np.std(y_raw)),
        "min": float(np.min(y_raw)),
        "max": float(np.max(y_raw)),
        "range": range_val,
        "cv": float(np.std(y_raw) / (np.abs(np.mean(y_raw)) + 1e-12)),
        "start_value": start_value,
        "end_value": end_value,
        "delta": delta,
        "delta_percent": float(delta / (abs(start_value) + 1e-12) * 100),  # % change from start
        "direction": direction,
        # Monotonicity flags
        "is_monotonic_increasing": is_monotonic_increasing,
        "is_monotonic_decreasing": is_monotonic_decreasing,
        "is_strictly_monotonic": is_strictly_monotonic_increasing or is_strictly_monotonic_decreasing,
        # Correlation with time
        "correlation_with_time": correlation_with_time,  # Pearson r: 1 = perfect positive, -1 = perfect negative
        "r_squared": r_squared,  # R² of linear fit: 1 = perfectly linear
        # Linear fit stats
        "linear_slope_per_index": slope_raw,
        "linear_intercept": intercept_raw,
        "total_variation": float(np.sum(np.abs(diffs))) if n0 > 1 else 0.0,
        "rms_diff": float(np.sqrt(np.mean(diffs * diffs))) if n0 > 1 else 0.0,
        "linfit_rmse": float(np.sqrt(sse_lin / n0)),
    }

    # --- normalize for SHAPE ---
    y_rs = _resample_to_n(y_raw, n_resample)
    if normalize.lower() == "zscore":
        y_shape = _zscore(y_rs)
    elif normalize.lower() in ("minmax", "min-max"):
        lo, hi = float(np.min(y_rs)), float(np.max(y_rs))
        denom = (hi - lo) if (hi - lo) > 1e-12 else 1.0
        y_shape = (y_rs - lo) / denom
        y_shape = y_shape - float(np.mean(y_shape))  # center to reduce offset effects
    else:
        raise ValueError("normalize must be 'zscore' or 'minmax'.")

    # x in [0,1] for shape fitting
    x = np.linspace(0.0, 1.0, n_resample)
    n = n_resample

    # --- candidate model fits (SSE, parameter count) ---
    # Grids chosen to be robust + fast; tune as needed.
    b_grid = np.linspace(-6.0, 6.0, 49)  # exponential rate
    k_grid = np.linspace(2.0, 20.0, 37)  # logistic steepness
    x0_grid = np.linspace(0.15, 0.85, 29)  # logistic midpoint
    mu_grid = np.linspace(0.15, 0.85, 29)
    sig_grid = np.linspace(0.05, 0.30, 18)
    t_grid = np.linspace(0.15, 0.85, 29)

    # Frequencies in "cycles over [0,1]": 1..max_freq_cycles
    f_grid = np.arange(1, max(2, max_freq_cycles + 1), dtype=float)
    d_grid = np.linspace(0.5, 8.0, 20)
    
    # Overshoot model grids
    peak_pos_grid = np.linspace(0.2, 0.5, 8)       # Where the peak occurs (0-1)
    overshoot_decay_grid = np.linspace(2.0, 8.0, 7)  # Decay rate after peak
    steady_state_grid = np.linspace(0.3, 0.7, 7)   # Final steady state as fraction of peak

    fits: Dict[str, Tuple[float, int]] = {}

    # Polynomials (trend/curvature families)
    fits["stable"] = _poly_model(x, y_shape, deg=0)
    fits["linear"] = _poly_model(x, y_shape, deg=1)
    fits["accelerating"] = _poly_model(x, y_shape, deg=2)
    fits["inflecting"] = _poly_model(x, y_shape, deg=3)

    # Nonlinear-but-fast families (via grid + linear inner solve)
    fits["exponential"] = _exp_model(y_shape, x, b_grid=b_grid)
    fits["s_curve"] = _logistic_model(y_shape, x, k_grid=k_grid, x0_grid=x0_grid)
    fits["bump"] = _gaussian_bump(y_shape, x, mu_grid=mu_grid, sig_grid=sig_grid)
    fits["step"] = _step_change(y_shape, x, t_grid=t_grid, allow_trend=False)
    fits["oscillating"] = _sine_model(y_shape, x, f_grid=f_grid)
    fits["dampening"] = _damped_sine_model(y_shape, x, f_grid=f_grid, d_grid=d_grid)
    fits["overshoot"] = _overshoot_model(y_shape, x, peak_pos_grid=peak_pos_grid, decay_rate_grid=overshoot_decay_grid, steady_state_grid=steady_state_grid)

    # --- score models with AICc ---
    aicc_scores: Dict[str, float] = {}
    for label, (sse, k) in fits.items():
        aic = _aic_from_sse(sse=sse, n=n, k=k)
        aicc_scores[label] = _aicc(aic=aic, n=n, k=k)

    probs = _weights_from_scores(aicc_scores)
    best_label = max(probs.items(), key=lambda kv: kv[1])[0]

    # Special case: detect flat/stable data
    # Check if data is near zero (inactive) - use absolute thresholds since CV is meaningless near zero
    max_abs_val = max(abs(scale["min"]), abs(scale["max"]))
    is_near_zero = max_abs_val < 0.1  # All values are close to zero
    
    # Check if data is essentially flat - use CV for non-zero data, absolute range for near-zero
    if is_near_zero:
        # For near-zero data, just check if range is small in absolute terms
        is_essentially_flat = scale["range"] < 0.15
    else:
        # For non-zero data, use coefficient of variation
        raw_cv = scale["cv"]
        is_essentially_flat = raw_cv < 0.1 or scale["range"] < 1e-9
    
    if is_near_zero and is_essentially_flat:
        # Data is essentially zero/inactive - strongly prefer stable (will become inactive)
        probs = {k: 0.02 for k in probs}
        probs["stable"] = 0.92
        best_label = "stable"  # Will be converted to "inactive" below due to near-zero mean
    elif is_essentially_flat and direction == "stable":
        # Data is essentially constant (but not zero) - strongly prefer stable
        probs = {k: 0.02 for k in probs}
        probs["stable"] = 0.92
        best_label = "stable"

    # optional "none-of-the-above/complex" diagnostic
    # (kept as metadata rather than a new class)
    best_sse, _ = fits[best_label]
    shape_rmse = float(np.sqrt(best_sse / n))
    complexity_flag = bool(shape_rmse > 0.85)  # tune threshold to taste

    # Determine direction suffix for the label
    # For oscillatory patterns, direction is less meaningful
    oscillatory_shapes = {"oscillating", "dampening"}
    bump_shape = "bump"
    
    if best_label in oscillatory_shapes:
        # For oscillating data, only add trend suffix if there's a strong underlying linear trend
        # Use R² of linear fit and relative slope to determine confidence in trend
        r_sq = scale["r_squared"]
        slope = scale["linear_slope_per_index"]
        range_val = scale["range"]
        # Relative slope: how much does it change per point relative to range
        relative_slope = abs(slope * n0) / (range_val + 1e-9)
        
        # Only assign trend if R² > 0.3 AND relative slope is significant (> 0.3)
        if r_sq > 0.3 and relative_slope > 0.3:
            if slope > 0:
                direction_suffix = "_trending_up"
            else:
                direction_suffix = "_trending_down"
        else:
            direction_suffix = ""
    elif best_label == bump_shape:
        # For bumps, determine if it's a peak (goes up then down) or dip (goes down then up)
        mid_idx = n_resample // 2
        first_half_mean = float(np.mean(y_shape[:mid_idx]))
        second_half_mean = float(np.mean(y_shape[mid_idx:]))
        center_mean = float(np.mean(y_shape[mid_idx - mid_idx//2 : mid_idx + mid_idx//2]))
        
        if center_mean > max(first_half_mean, second_half_mean):
            # Replace 'bump' entirely with 'peak'
            best_label = "peak"
            direction_suffix = ""
        elif center_mean < min(first_half_mean, second_half_mean):
            # Replace 'bump' entirely with 'dip'
            best_label = "dip"
            direction_suffix = ""
        else:
            direction_suffix = ""
    elif best_label == "stable":
        mean_val = scale["mean"]
        range_val_check = scale["range"]
        max_abs_val = max(abs(scale["min"]), abs(scale["max"]))
        # Inactive if: values are all near zero (max absolute value is very small)
        # or mean is near zero and range is small
        near_zero = max_abs_val < 0.1 or (abs(mean_val) < 0.05 and range_val_check < 0.1)
        if near_zero:
            best_label = "inactive"
        direction_suffix = ""
    elif best_label == "overshoot":
        # Overshoot: determine if it overshoots up then settles (overshoot_up)
        # or overshoots down then settles (overshoot_down)
        # Check if the peak of the series is above or below the settling value (end)
        max_idx = int(np.argmax(y_shape))
        min_idx = int(np.argmin(y_shape))
        # If max is in the middle and series settles lower, it's overshoot_up
        # If min is in the middle and series settles higher, it's overshoot_down
        mid_third_start = n_resample // 4
        mid_third_end = 3 * n_resample // 4
        if mid_third_start < max_idx < mid_third_end and y_shape[-1] < y_shape[max_idx] - 0.1:
            direction_suffix = "_up"
        elif mid_third_start < min_idx < mid_third_end and y_shape[-1] > y_shape[min_idx] + 0.1:
            direction_suffix = "_down"
        else:
            direction_suffix = ""
    elif best_label == "step":
        # Step changes: step_up or step_down
        if direction == "increasing":
            direction_suffix = "_up"
        elif direction == "decreasing":
            direction_suffix = "_down"
        else:
            direction_suffix = ""
    else:
        # For trend shapes (linear, accelerating, inflecting, exponential, s_curve)
        if direction == "increasing":
            direction_suffix = "_growth"
        elif direction == "decreasing":
            direction_suffix = "_decline"
        else:
            direction_suffix = "_flat"
    
    # Create labeled version with direction
    best_label_with_direction = best_label + direction_suffix

    return {
        "shape": {
            "best_label": best_label_with_direction,
            "base_shape": best_label,  # Original label without direction
            "direction": direction,
            "probabilities": dict(sorted(probs.items(), key=lambda kv: kv[1], reverse=True)),
            "scores_aicc": dict(sorted(aicc_scores.items(), key=lambda kv: kv[1])),
            "normalized_series": y_shape.tolist(),
            "shape_rmse": shape_rmse,
            "possibly_complex_or_unmodeled": complexity_flag,
            "normalization": normalize,
            "n_resample": n_resample,
        },
        "scale": scale,
    }


# --- example ---
if __name__ == "__main__":
    rng = np.random.default_rng(0)
    
    print("=" * 60)
    print("Example 1: S-curve UP (growth)")
    t = np.arange(300)
    y = 1 / (1 + np.exp(-0.06 * (t - 140))) + 0.03 * rng.normal(size=t.size)
    out = classify_timeseries_shape_and_scale(y, n_resample=240)
    print(f"  Best: {out['shape']['best_label']}")
    print(f"  Direction: {out['shape']['direction']}")
    print(f"  Start: {out['scale']['start_value']:.4f}, End: {out['scale']['end_value']:.4f}, Delta: {out['scale']['delta']:.4f}")
    
    print("\n" + "=" * 60)
    print("Example 2: S-curve DOWN (decline)")
    y_down = 1 - 1 / (1 + np.exp(-0.06 * (t - 140))) + 0.03 * rng.normal(size=t.size)
    out_down = classify_timeseries_shape_and_scale(y_down, n_resample=240)
    print(f"  Best: {out_down['shape']['best_label']}")
    print(f"  Direction: {out_down['shape']['direction']}")
    print(f"  Start: {out_down['scale']['start_value']:.4f}, End: {out_down['scale']['end_value']:.4f}, Delta: {out_down['scale']['delta']:.4f}")
    
    print("\n" + "=" * 60)
    print("Example 3: Exponential growth")
    y_exp = np.exp(0.01 * t) + 0.5 * rng.normal(size=t.size)
    out_exp = classify_timeseries_shape_and_scale(y_exp, n_resample=240)
    print(f"  Best: {out_exp['shape']['best_label']}")
    print(f"  Direction: {out_exp['shape']['direction']}")
    print(f"  Start: {out_exp['scale']['start_value']:.4f}, End: {out_exp['scale']['end_value']:.4f}, Delta: {out_exp['scale']['delta']:.4f}")
    
    print("\n" + "=" * 60)
    print("Example 4: Exponential decay")
    y_decay = np.exp(-0.01 * t) + 0.01 * rng.normal(size=t.size)
    out_decay = classify_timeseries_shape_and_scale(y_decay, n_resample=240)
    print(f"  Best: {out_decay['shape']['best_label']}")
    print(f"  Direction: {out_decay['shape']['direction']}")
    print(f"  Start: {out_decay['scale']['start_value']:.4f}, End: {out_decay['scale']['end_value']:.4f}, Delta: {out_decay['scale']['delta']:.4f}")
    
    print("\n" + "=" * 60)
    print("Example 5: Peak (bump up)")
    y_peak = np.exp(-((t - 150)**2) / 2000) + 0.02 * rng.normal(size=t.size)
    out_peak = classify_timeseries_shape_and_scale(y_peak, n_resample=240)
    print(f"  Best: {out_peak['shape']['best_label']}")
    print(f"  Direction: {out_peak['shape']['direction']}")
    
    print("\n" + "=" * 60)
    print("Example 6: Dip (bump down)")
    y_dip = 1 - np.exp(-((t - 150)**2) / 2000) + 0.02 * rng.normal(size=t.size)
    out_dip = classify_timeseries_shape_and_scale(y_dip, n_resample=240)
    print(f"  Best: {out_dip['shape']['best_label']}")
    print(f"  Direction: {out_dip['shape']['direction']}")
    
    print(out_dip)
