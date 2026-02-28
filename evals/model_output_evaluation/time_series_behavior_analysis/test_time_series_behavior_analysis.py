"""
Tests for the time_series_behavior_analysis module.

This module tests the classify_timeseries_shape_and_scale function
and its helper functions for time series shape classification.
"""

import pytest
import numpy as np
from . import (
    classify_timeseries_shape_and_scale,
    _nan_interp,
    _resample_to_n,
    _zscore,
    _aic_from_sse,
    _aicc,
    _weights_from_scores,
    _ols_fit,
    _poly_model,
)


class TestNanInterp:
    """Tests for the _nan_interp function."""

    def test_no_nans(self):
        """Should return the same array when no NaNs present."""
        y = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        result = _nan_interp(y)
        np.testing.assert_array_almost_equal(result, y)

    def test_single_nan_middle(self):
        """Should interpolate a single NaN in the middle."""
        y = np.array([1.0, 2.0, np.nan, 4.0, 5.0])
        result = _nan_interp(y)
        expected = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        np.testing.assert_array_almost_equal(result, expected)

    def test_multiple_nans(self):
        """Should interpolate multiple NaNs."""
        y = np.array([1.0, np.nan, np.nan, 4.0, 5.0])
        result = _nan_interp(y)
        # Linear interpolation between 1.0 and 4.0
        expected = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        np.testing.assert_array_almost_equal(result, expected)

    def test_nan_at_start(self):
        """Should handle NaN at the start (extrapolation via interp)."""
        y = np.array([np.nan, 2.0, 3.0, 4.0, 5.0])
        result = _nan_interp(y)
        # np.interp extrapolates with the first known value
        assert np.isfinite(result[0])

    def test_nan_at_end(self):
        """Should handle NaN at the end (extrapolation via interp)."""
        y = np.array([1.0, 2.0, 3.0, 4.0, np.nan])
        result = _nan_interp(y)
        # np.interp extrapolates with the last known value
        assert np.isfinite(result[-1])

    def test_all_nan_raises(self):
        """Should raise ValueError when all values are NaN."""
        y = np.array([np.nan, np.nan, np.nan])
        with pytest.raises(ValueError, match="no finite values"):
            _nan_interp(y)

    def test_empty_raises(self):
        """Should raise ValueError for empty array."""
        y = np.array([])
        with pytest.raises(ValueError, match="Empty time series"):
            _nan_interp(y)


class TestResampleToN:
    """Tests for the _resample_to_n function."""

    def test_same_length(self):
        """Should return same array when lengths match."""
        y = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        result = _resample_to_n(y, 5)
        np.testing.assert_array_almost_equal(result, y)

    def test_upsample(self):
        """Should upsample to larger length."""
        y = np.array([0.0, 1.0])
        result = _resample_to_n(y, 5)
        assert len(result) == 5
        # Should be linearly interpolated
        expected = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
        np.testing.assert_array_almost_equal(result, expected)

    def test_downsample(self):
        """Should downsample to smaller length."""
        y = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
        result = _resample_to_n(y, 3)
        assert len(result) == 3
        # Endpoints should match
        assert result[0] == pytest.approx(0.0)
        assert result[-1] == pytest.approx(1.0)


class TestZscore:
    """Tests for the _zscore function."""

    def test_standard_normalization(self):
        """Should produce zero mean and unit std."""
        y = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        result = _zscore(y)
        assert np.mean(result) == pytest.approx(0.0, abs=1e-10)
        assert np.std(result) == pytest.approx(1.0, abs=1e-10)

    def test_constant_series(self):
        """Should handle constant series (zero std) gracefully."""
        y = np.array([5.0, 5.0, 5.0, 5.0, 5.0])
        result = _zscore(y)
        # Should just center without dividing by zero
        np.testing.assert_array_almost_equal(result, np.zeros_like(y))


class TestAicFromSse:
    """Tests for the _aic_from_sse function."""

    def test_basic_calculation(self):
        """Should compute AIC from SSE."""
        n, k, sse = 100, 2, 10.0
        aic = _aic_from_sse(sse, n, k)
        # AIC = n * ln(SSE/n) + 2k
        expected = n * np.log(sse / n) + 2 * k
        assert aic == pytest.approx(expected)

    def test_zero_sse_uses_eps(self):
        """Should handle zero SSE by using epsilon."""
        aic = _aic_from_sse(0.0, 100, 2)
        assert np.isfinite(aic)


class TestAicc:
    """Tests for the _aicc function."""

    def test_small_sample_correction(self):
        """AICc should be larger than AIC for small samples."""
        aic = 100.0
        n, k = 20, 3
        aicc = _aicc(aic, n, k)
        assert aicc > aic

    def test_large_sample_approaches_aic(self):
        """AICc should approach AIC for large samples."""
        aic = 100.0
        n, k = 10000, 3
        aicc = _aicc(aic, n, k)
        # Difference should be negligible
        assert abs(aicc - aic) < 0.1

    def test_overparameterized_penalty(self):
        """Should return heavy penalty when n <= k+1."""
        aic = 100.0
        n, k = 3, 5  # n <= k+1
        aicc = _aicc(aic, n, k)
        assert aicc > 1e5  # Heavy penalty


class TestWeightsFromScores:
    """Tests for the _weights_from_scores function."""

    def test_weights_sum_to_one(self):
        """Weights should sum to approximately 1."""
        scores = {"a": 100.0, "b": 102.0, "c": 110.0}
        weights = _weights_from_scores(scores)
        assert sum(weights.values()) == pytest.approx(1.0)

    def test_lower_score_higher_weight(self):
        """Lower AIC score should have higher weight."""
        scores = {"a": 100.0, "b": 110.0, "c": 120.0}
        weights = _weights_from_scores(scores)
        assert weights["a"] > weights["b"] > weights["c"]

    def test_equal_scores_equal_weights(self):
        """Equal scores should produce equal weights."""
        scores = {"a": 100.0, "b": 100.0, "c": 100.0}
        weights = _weights_from_scores(scores)
        assert weights["a"] == pytest.approx(weights["b"])
        assert weights["b"] == pytest.approx(weights["c"])


class TestOlsFit:
    """Tests for the _ols_fit function."""

    def test_perfect_fit(self):
        """Should achieve zero SSE for perfect linear fit."""
        x = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        y = 2 * x + 3  # y = 2x + 3
        design = np.column_stack([x, np.ones_like(x)])
        beta, sse = _ols_fit(design, y)
        assert beta[0] == pytest.approx(2.0)
        assert beta[1] == pytest.approx(3.0)
        assert sse == pytest.approx(0.0, abs=1e-10)


class TestPolyModel:
    """Tests for the _poly_model function."""

    def test_linear_fit(self):
        """Should fit linear model with deg=1."""
        x = np.linspace(0, 1, 50)
        y = 2 * x + 1
        sse, k = _poly_model(x, y, deg=1)
        assert k == 2  # slope + intercept
        assert sse < 1e-10  # Perfect fit

    def test_quadratic_fit(self):
        """Should fit quadratic model with deg=2."""
        x = np.linspace(0, 1, 50)
        y = x**2 - 0.5 * x + 1
        sse, k = _poly_model(x, y, deg=2)
        assert k == 3  # a, b, c coefficients
        assert sse < 1e-10  # Perfect fit


class TestClassifyTimeseriesShapeAndScale:
    """Tests for the main classify_timeseries_shape_and_scale function."""

    def test_flat_series(self):
        """Should classify constant series as stable."""
        y = [5.0] * 100
        result = classify_timeseries_shape_and_scale(y)
        assert result["shape"]["base_shape"] == "stable"
        assert "probabilities" in result["shape"]
        assert "scale" in result

    def test_linear_increasing(self):
        """Should classify linear trend as linear."""
        t = np.linspace(0, 10, 100)
        y = 2 * t + 1
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] == "linear"
        assert result["shape"]["direction"] == "increasing"

    def test_linear_decreasing(self):
        """Should classify decreasing linear trend as linear."""
        t = np.linspace(0, 10, 100)
        y = -3 * t + 50
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] == "linear"
        assert result["shape"]["direction"] == "decreasing"

    def test_quadratic_shape(self):
        """Should classify parabolic shape as accelerating."""
        t = np.linspace(0, 1, 100)
        y = t**2 - t + 0.5
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] in ["accelerating", "bump"]

    def test_exponential_growth(self):
        """Should classify exponential growth."""
        t = np.linspace(0, 5, 100)
        y = np.exp(0.5 * t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] in ["exponential", "linear", "accelerating"]

    def test_sigmoid_s_curve(self):
        """Should classify S-curve / logistic shape."""
        rng = np.random.default_rng(42)
        t = np.linspace(0, 300, 200)
        y = 1 / (1 + np.exp(-0.06 * (t - 150))) + 0.01 * rng.normal(size=t.size)
        result = classify_timeseries_shape_and_scale(y.tolist())
        # Should be classified as s_curve or similar
        assert result["shape"]["base_shape"] in ["s_curve", "step", "exponential"]

    def test_step_change(self):
        """Should classify sudden step change."""
        y = [0.0] * 50 + [1.0] * 50
        result = classify_timeseries_shape_and_scale(y)
        assert result["shape"]["base_shape"] in ["step", "s_curve"]

    def test_oscillation_sine_wave(self):
        """Should classify sine wave as oscillating."""
        t = np.linspace(0, 4 * np.pi, 200)
        y = np.sin(t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] in ["oscillating", "dampening"]

    def test_single_peak(self):
        """Should classify single peak/bump shape."""
        t = np.linspace(0, 1, 100)
        y = np.exp(-((t - 0.5) ** 2) / 0.02)  # Gaussian peak
        result = classify_timeseries_shape_and_scale(y.tolist())
        # base_shape becomes "peak" when detected as a peak
        assert result["shape"]["base_shape"] in ["peak", "bump", "accelerating"]

    def test_output_structure(self):
        """Should return correct output structure."""
        y = list(range(50))
        result = classify_timeseries_shape_and_scale(y)

        # Check shape structure
        assert "shape" in result
        assert "best_label" in result["shape"]
        assert "base_shape" in result["shape"]
        assert "direction" in result["shape"]
        assert "probabilities" in result["shape"]
        assert "scores_aicc" in result["shape"]
        assert "shape_rmse" in result["shape"]
        assert "possibly_complex_or_unmodeled" in result["shape"]
        assert "normalization" in result["shape"]
        assert "n_resample" in result["shape"]

        # Check scale structure
        assert "scale" in result
        scale = result["scale"]
        assert "n_points" in scale
        assert "mean" in scale
        assert "std" in scale
        assert "min" in scale
        assert "max" in scale
        assert "range" in scale
        assert "cv" in scale
        assert "start_value" in scale
        assert "end_value" in scale
        assert "delta" in scale
        assert "delta_percent" in scale
        assert "direction" in scale
        assert "linear_slope_per_index" in scale
        assert "linear_intercept" in scale
        assert "total_variation" in scale
        assert "rms_diff" in scale
        assert "linfit_rmse" in scale

    def test_probabilities_sum_to_one(self):
        """Probabilities should sum to approximately 1."""
        y = list(range(50))
        result = classify_timeseries_shape_and_scale(y)
        probs = result["shape"]["probabilities"]
        assert sum(probs.values()) == pytest.approx(1.0)

    def test_scale_statistics_correct(self):
        """Should compute correct scale statistics."""
        y = [1.0, 2.0, 3.0, 4.0, 5.0]
        result = classify_timeseries_shape_and_scale(y)
        scale = result["scale"]

        assert scale["n_points"] == 5
        assert scale["mean"] == pytest.approx(3.0)
        assert scale["min"] == pytest.approx(1.0)
        assert scale["max"] == pytest.approx(5.0)
        assert scale["range"] == pytest.approx(4.0)
        assert scale["start_value"] == pytest.approx(1.0)
        assert scale["end_value"] == pytest.approx(5.0)
        assert scale["delta"] == pytest.approx(4.0)
        assert scale["direction"] == "increasing"

    def test_short_series_raises(self):
        """Should raise error for very short series."""
        y = [1.0, 2.0, 3.0]  # Less than 5 points
        with pytest.raises(ValueError, match="too short"):
            classify_timeseries_shape_and_scale(y)

    def test_handles_nan_values(self):
        """Should handle NaN values via interpolation."""
        y = [1.0, 2.0, np.nan, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
        result = classify_timeseries_shape_and_scale(y)
        assert result["shape"]["base_shape"] == "linear"

    def test_custom_n_resample(self):
        """Should use custom n_resample parameter."""
        y = list(range(100))
        result = classify_timeseries_shape_and_scale(y, n_resample=50)
        assert result["shape"]["n_resample"] == 50
        assert len(result["shape"]["normalized_series"]) == 50

    def test_zscore_normalization(self):
        """Should use zscore normalization by default."""
        y = list(range(50))
        result = classify_timeseries_shape_and_scale(y, normalize="zscore")
        assert result["shape"]["normalization"] == "zscore"

    def test_minmax_normalization(self):
        """Should support minmax normalization."""
        y = list(range(50))
        result = classify_timeseries_shape_and_scale(y, normalize="minmax")
        assert result["shape"]["normalization"] == "minmax"

    def test_invalid_normalization_raises(self):
        """Should raise error for invalid normalization method."""
        y = list(range(50))
        with pytest.raises(ValueError, match="normalize must be"):
            classify_timeseries_shape_and_scale(y, normalize="invalid")


class TestEdgeCases:
    """Tests for edge cases and robustness."""

    def test_noisy_linear(self):
        """Should handle noisy linear data."""
        rng = np.random.default_rng(123)
        t = np.linspace(0, 10, 200)
        # Use smaller noise relative to signal strength
        y = 2 * t + 5 + rng.normal(0, 0.3, size=200)
        result = classify_timeseries_shape_and_scale(y.tolist())
        # Should recognize dominant linear trend (may classify as step with high noise)
        assert result["shape"]["base_shape"] in ["linear", "step", "accelerating"]

    def test_very_large_values(self):
        """Should handle very large values."""
        y = [1e9 + i for i in range(50)]
        result = classify_timeseries_shape_and_scale(y)
        assert result["shape"]["base_shape"] == "linear"
        assert result["scale"]["mean"] > 1e9

    def test_very_small_values(self):
        """Should handle very small values - values near zero are classified as inactive."""
        y = [1e-9 * i for i in range(50)]
        result = classify_timeseries_shape_and_scale(y)
        # Values are all extremely close to zero (max ~4.9e-8 < 0.1 threshold)
        # so they are correctly classified as inactive, not linear
        assert result["shape"]["base_shape"] == "inactive"

    def test_negative_values(self):
        """Should handle negative values."""
        y = [-50 + i for i in range(100)]
        result = classify_timeseries_shape_and_scale(y)
        assert result["shape"]["base_shape"] == "linear"
        assert result["scale"]["min"] < 0

    def test_mixed_positive_negative(self):
        """Should handle series crossing zero."""
        t = np.linspace(-np.pi, np.pi, 100)
        y = np.sin(t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] in ["oscillating", "inflecting", "dampening"]

    def test_damped_oscillation(self):
        """Should classify damped oscillation as dampening."""
        t = np.linspace(0, 10, 200)
        y = np.exp(-0.3 * t) * np.sin(4 * t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        # Should recognize dampening oscillation or similar
        assert result["shape"]["base_shape"] in ["dampening", "oscillating", "bump"]


class TestIntegration:
    """Integration tests with realistic scenarios."""

    def test_adoption_curve(self):
        """Should classify technology adoption (S-curve) pattern."""
        rng = np.random.default_rng(999)
        t = np.linspace(0, 12, 150)
        # Technology adoption S-curve
        y = 100 / (1 + np.exp(-0.8 * (t - 6))) + rng.normal(0, 2, size=150)
        result = classify_timeseries_shape_and_scale(y.tolist())
        # Should be s_curve-like with upward direction
        assert result["shape"]["base_shape"] in ["s_curve", "step", "exponential"]

    def test_seasonal_pattern(self):
        """Should classify seasonal/periodic pattern."""
        t = np.linspace(0, 3, 150)  # 3 cycles
        y = 10 + 5 * np.sin(2 * np.pi * t)
        result = classify_timeseries_shape_and_scale(y.tolist(), max_freq_cycles=4)
        assert result["shape"]["base_shape"] in ["oscillating", "dampening"]

    def test_exponential_decay(self):
        """Should classify exponential decay."""
        t = np.linspace(0, 5, 100)
        y = 100 * np.exp(-0.5 * t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        assert result["shape"]["base_shape"] in ["exponential", "accelerating"]

    def test_random_walk_flags_complex(self):
        """Random walk may trigger possibly_complex flag."""
        rng = np.random.default_rng(42)
        y = np.cumsum(rng.normal(0, 1, 200))
        result = classify_timeseries_shape_and_scale(y.tolist())
        # May or may not flag as complex depending on realization
        # Just ensure it completes without error
        assert "shape" in result
        assert "best_label" in result["shape"]


class TestDirectionDetection:
    """Tests for direction detection feature."""

    def test_s_curve_up(self):
        """Should detect S-curve growth as increasing."""
        rng = np.random.default_rng(42)
        t = np.arange(300)
        y = 1 / (1 + np.exp(-0.06 * (t - 140))) + 0.03 * rng.normal(size=t.size)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        assert result["shape"]["base_shape"] == "s_curve"
        assert result["shape"]["direction"] == "increasing"
        assert "_growth" in result["shape"]["best_label"]
        assert result["scale"]["direction"] == "increasing"
        assert result["scale"]["delta"] > 0

    def test_s_curve_down(self):
        """Should detect S-curve decline as decreasing."""
        rng = np.random.default_rng(42)
        t = np.arange(300)
        y = 1 - 1 / (1 + np.exp(-0.06 * (t - 140))) + 0.03 * rng.normal(size=t.size)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        assert result["shape"]["base_shape"] == "s_curve"
        assert result["shape"]["direction"] == "decreasing"
        assert "_decline" in result["shape"]["best_label"]
        assert result["scale"]["direction"] == "decreasing"
        assert result["scale"]["delta"] < 0

    def test_exponential_growth(self):
        """Should detect exponential growth as increasing."""
        t = np.linspace(0, 5, 100)
        y = np.exp(0.5 * t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        assert result["shape"]["direction"] == "increasing"
        assert result["scale"]["delta"] > 0
        assert result["scale"]["end_value"] > result["scale"]["start_value"]

    def test_exponential_decay(self):
        """Should detect exponential decay as decreasing."""
        t = np.linspace(0, 5, 100)
        y = 100 * np.exp(-0.5 * t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        assert result["shape"]["direction"] == "decreasing"
        assert result["scale"]["delta"] < 0
        assert result["scale"]["end_value"] < result["scale"]["start_value"]

    def test_linear_increasing(self):
        """Should detect linear increase with _growth suffix."""
        y = list(range(100))
        result = classify_timeseries_shape_and_scale(y)
        
        assert result["shape"]["base_shape"] == "linear"
        assert result["shape"]["direction"] == "increasing"
        assert result["shape"]["best_label"] == "linear_growth"

    def test_linear_decreasing(self):
        """Should detect linear decrease with _decline suffix."""
        y = list(range(100, 0, -1))
        result = classify_timeseries_shape_and_scale(y)
        
        assert result["shape"]["base_shape"] == "linear"
        assert result["shape"]["direction"] == "decreasing"
        assert result["shape"]["best_label"] == "linear_decline"

    def test_flat_no_direction_suffix(self):
        """Stable series should not have direction suffix."""
        y = [5.0] * 100
        result = classify_timeseries_shape_and_scale(y)
        
        assert result["shape"]["base_shape"] == "stable"
        assert result["shape"]["best_label"] == "stable"  # No suffix

    def test_peak_detection(self):
        """Should detect peak (bump up) shape."""
        t = np.linspace(0, 1, 100)
        y = np.exp(-((t - 0.5) ** 2) / 0.02)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        # base_shape becomes 'peak' when bump is detected as peak
        assert result["shape"]["base_shape"] == "peak"
        assert result["shape"]["best_label"] == "peak"

    def test_dip_detection(self):
        """Should detect dip (bump down) shape."""
        t = np.linspace(0, 1, 100)
        y = 1 - np.exp(-((t - 0.5) ** 2) / 0.02)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        # base_shape becomes 'dip' when bump is detected as dip
        assert result["shape"]["base_shape"] == "dip"
        assert result["shape"]["best_label"] == "dip"

    def test_step_change_up(self):
        """Should detect step change upward."""
        y = [0.0] * 50 + [1.0] * 50
        result = classify_timeseries_shape_and_scale(y)
        
        assert result["shape"]["direction"] == "increasing"
        assert result["scale"]["delta"] > 0
        assert "_up" in result["shape"]["best_label"]

    def test_step_change_down(self):
        """Should detect step change downward."""
        y = [1.0] * 50 + [0.0] * 50
        result = classify_timeseries_shape_and_scale(y)
        
        assert result["shape"]["direction"] == "decreasing"
        assert result["scale"]["delta"] < 0
        assert "_down" in result["shape"]["best_label"]

    def test_stable_oscillation(self):
        """Oscillation with no trend should be stable."""
        t = np.linspace(0, 4 * np.pi, 200)
        y = np.sin(t)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        # Oscillation starting and ending near same value
        assert result["shape"]["base_shape"] in ["oscillating", "dampening"]
        # Direction could vary slightly depending on exact endpoint, so just check base shape

    def test_delta_percent_calculation(self):
        """Should calculate delta percent correctly."""
        # Create a clear 100% increase: 10 -> 20
        y = [10.0] * 25 + [20.0] * 25  # 50 points total, clear start at 10, end at 20
        result = classify_timeseries_shape_and_scale(y)
        
        # Delta percent should be approximately 100% (start at 10, end at 20)
        assert result["scale"]["start_value"] == pytest.approx(10.0, rel=0.1)
        assert result["scale"]["end_value"] == pytest.approx(20.0, rel=0.1)
        assert result["scale"]["delta"] == pytest.approx(10.0, rel=0.1)
        assert result["scale"]["delta_percent"] == pytest.approx(100.0, rel=0.1)

    def test_start_end_averaging(self):
        """Start/end values should be robust to noise via averaging."""
        rng = np.random.default_rng(42)
        # Linear trend with noise
        t = np.arange(100)
        y = t + rng.normal(0, 2, size=100)
        result = classify_timeseries_shape_and_scale(y.tolist())
        
        # Start should be near 0, end near 99 (with some noise tolerance)
        assert result["scale"]["start_value"] < 10
        assert result["scale"]["end_value"] > 90
        assert result["scale"]["delta"] > 80


class TestOvershootDetection:
    """Tests for overshoot and collapse pattern detection."""
    
    def test_overshoot_up(self):
        """Test detection of overshoot that goes up then settles."""
        t = np.linspace(0, 1, 200)
        # Second-order step response with overshoot: rises, overshoots, settles
        tau = 0.15
        omega = 15.0
        y = 1 - np.exp(-t/tau) * (np.cos(omega*t) + (1/(omega*tau))*np.sin(omega*t))
        y = y + 0.02 * np.random.randn(len(y))  # Add small noise
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        best = result["shape"]["best_label"]
        # Should detect overshoot_up or possibly s_curve/dampening
        assert "overshoot" in best or "s_curve" in best or "dampening" in best, f"Got {best}"
    
    def test_overshoot_down(self):
        """Test detection of overshoot that goes down then settles."""
        t = np.linspace(0, 1, 200)
        # Inverted overshoot: drops, undershoots, settles
        tau = 0.15
        omega = 15.0
        y = -1 + np.exp(-t/tau) * (np.cos(omega*t) + (1/(omega*tau))*np.sin(omega*t))
        y = y + 0.02 * np.random.randn(len(y))  # Add small noise
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        best = result["shape"]["best_label"]
        # Should detect overshoot_down or possibly s_curve/dampening
        assert "overshoot" in best or "s_curve" in best or "dampening" in best, f"Got {best}"
    
    def test_overshoot_model_in_probabilities(self):
        """Test that overshoot is in the model probabilities."""
        t = np.linspace(0, 1, 200)
        y = np.sin(t * 10) * np.exp(-t * 3)  # Some signal
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        # Overshoot should be one of the compared models
        assert "overshoot" in result["shape"]["scores_aicc"]


class TestNearZeroDetection:
    """Tests for near-zero stable (inactive) pattern detection."""
    
    def test_all_zeros(self):
        """Test detection of all zeros as inactive."""
        y = np.zeros(100)
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        best = result["shape"]["best_label"]
        base = result["shape"]["base_shape"]
        
        # Should be detected as 'inactive'
        assert best == "inactive", f"All zeros should be inactive, got {best}"
        assert base == "inactive", f"Base should be inactive, got {base}"
    
    def test_near_zeros_with_tiny_variation(self):
        """Test detection of near-zero values with tiny variation."""
        # Create a flat line very close to zero with minimal variation
        # Using a constant tiny value to avoid noise artifacts
        y = np.full(100, 1e-10)
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        best = result["shape"]["best_label"]
        base = result["shape"]["base_shape"]
        
        # When the signal is truly flat near zero, it should be detected as 'inactive'
        assert base == "inactive", f"Flat near-zero should be inactive, got {base}"
        assert best == "inactive", f"Label should be inactive, got {best}"
    
    def test_small_values_not_near_zero(self):
        """Test that small but non-zero stable values are 'stable', not 'inactive'."""
        # Values around 10 - constant (no random noise to avoid accidental trends)
        y = np.ones(100) * 10
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        best = result["shape"]["best_label"]
        base = result["shape"]["base_shape"]
        
        # Mean (10) is much larger than range (0), so not near-zero
        # Should be 'stable', not 'inactive'
        assert base == "stable", f"Expected stable for non-zero constant, got {base}"
        assert best == "stable", f"Expected stable label, got {best}"
    
    def test_zero_mean_oscillation_not_inactive(self):
        """Test that oscillations around zero are not classified as inactive."""
        t = np.linspace(0, 4*np.pi, 200)
        y = np.sin(t)  # Mean is ~0 but not inactive - it's oscillating!
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        best = result["shape"]["best_label"]
        
        # Should be oscillating, not inactive
        assert "oscillating" in best, f"Sine wave should be oscillating, got {best}"
    
    def test_inactive_vs_stable_distinction(self):
        """Test the difference between inactive (near-zero) and stable (non-zero constant)."""
        # Near-zero flat - truly constant at zero
        y_zero = np.zeros(100)
        result_zero = classify_timeseries_shape_and_scale(y_zero, n_resample=64)
        
        # Non-zero flat (constant at 100)
        y_nonzero = np.ones(100) * 100
        result_nonzero = classify_timeseries_shape_and_scale(y_nonzero, n_resample=64)
        
        assert result_zero["shape"]["base_shape"] == "inactive"
        assert result_nonzero["shape"]["base_shape"] == "stable"


class TestMonotonicityAndCorrelation:
    """Tests for monotonicity detection and correlation with time."""
    
    def test_perfectly_monotonic_increasing(self):
        """Test detection of perfectly monotonic increasing series."""
        y = np.arange(100)  # 0, 1, 2, ..., 99
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is True
        assert scale["is_monotonic_decreasing"] is False
        assert scale["is_strictly_monotonic"] is True
        assert scale["correlation_with_time"] > 0.999  # Should be ~1.0
        assert scale["r_squared"] > 0.999  # Perfect linear fit
    
    def test_perfectly_monotonic_decreasing(self):
        """Test detection of perfectly monotonic decreasing series."""
        y = np.arange(100, 0, -1)  # 100, 99, 98, ..., 1
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is False
        assert scale["is_monotonic_decreasing"] is True
        assert scale["is_strictly_monotonic"] is True
        assert scale["correlation_with_time"] < -0.999  # Should be ~-1.0
        assert scale["r_squared"] > 0.999  # Perfect linear fit
    
    def test_monotonic_with_flats(self):
        """Test monotonic (non-strictly) with some flat sections."""
        # [0, 0, 1, 1, 2, 2, 3, 3, ...]
        y = np.repeat(np.arange(50), 2)
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is True
        assert scale["is_strictly_monotonic"] is False  # Has flat sections
    
    def test_non_monotonic(self):
        """Test detection of non-monotonic series."""
        t = np.linspace(0, 4*np.pi, 200)
        y = np.sin(t)  # Goes up and down
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is False
        assert scale["is_monotonic_decreasing"] is False
        assert scale["is_strictly_monotonic"] is False
    
    def test_exponential_is_monotonic(self):
        """Test that exponential growth is still monotonic."""
        t = np.linspace(0, 3, 100)
        y = np.exp(t)
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is True
        assert scale["is_strictly_monotonic"] is True
        # But correlation won't be 1.0 since it's not linear
        assert 0.8 < scale["correlation_with_time"] < 1.0
        # R² won't be 1.0 since it's not linear
        assert scale["r_squared"] < 1.0
    
    def test_s_curve_is_monotonic(self):
        """Test that S-curve is monotonic."""
        t = np.linspace(-5, 5, 200)
        y = 1 / (1 + np.exp(-t))  # Logistic sigmoid
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        scale = result["scale"]
        
        assert scale["is_monotonic_increasing"] is True
        assert scale["is_strictly_monotonic"] is True
    
    def test_correlation_near_zero_for_oscillation(self):
        """Test that pure oscillation has correlation much lower than trend."""
        # Use exactly 2 full cycles for symmetric oscillation
        t = np.linspace(0, 4*np.pi, 201)  # 201 points = complete cycles
        y = np.sin(t)
        
        result = classify_timeseries_shape_and_scale(y, n_resample=120)
        scale = result["scale"]
        
        # Correlation should be low for oscillation (not close to ±1)
        assert abs(scale["correlation_with_time"]) < 0.5
    
    def test_constant_series_correlation(self):
        """Test correlation for constant series."""
        y = np.ones(100) * 5
        
        result = classify_timeseries_shape_and_scale(y, n_resample=64)
        scale = result["scale"]
        
        # Constant series has undefined correlation (we return 0)
        assert scale["correlation_with_time"] == 0.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
