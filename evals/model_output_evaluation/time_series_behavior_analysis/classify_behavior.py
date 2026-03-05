"""
Time Series Behavior Classification CLI Tool

This module provides a command-line interface for classifying time series data
into behavioral patterns using the time_series_behavior_analysis library.

Usage:
    As a command-line tool:
        python classify_behavior.py input.csv --output results.json
        python classify_behavior.py input.csv --column "value" --format json
    
    As a standalone executable (after building):
        classify_behavior.exe input.csv --format json
        classify_behavior.exe --list-patterns
"""

import argparse
import json
import sys
import csv
from typing import Optional, Dict, Any, List
from pathlib import Path
from dataclasses import dataclass, asdict

import numpy as np

# Import from parent module - handle both normal and PyInstaller frozen cases
if getattr(sys, 'frozen', False):
    # Running as compiled executable
    base_path = Path(sys._MEIPASS)
    sys.path.insert(0, str(base_path))

from __init__ import classify_timeseries_shape_and_scale


@dataclass
class ClassificationResult:
    """Result of a behavior classification."""
    best_label: str
    base_shape: str
    direction: str
    probabilities: Dict[str, float]
    shape_rmse: float
    possibly_complex: bool
    scale_metadata: Dict[str, Any]
    top_matches: List[Dict[str, Any]]


# Pattern descriptions for all behavior modes
PATTERN_DESCRIPTIONS = {
    # Base shapes (without direction suffix)
    "stable": "Constant/Stasis - no significant change over time",
    "inactive": "Zero/Inactive - values near zero throughout",
    "linear": "Linear trend - steady rate of change",
    "accelerating": "Accelerating/Quadratic - changing rate of change",
    "inflecting": "Inflecting/Cubic - S-shaped or changing acceleration",
    "exponential": "Exponential - rapid accelerating growth or decay",
    "logarithmic": "Logarithmic - fast early change that decelerates",
    "s_curve": "S-Curve/Sigmoid - logistic growth or decay to asymptote",
    "bump": "Bump - temporary rise or fall then return",
    "step": "Step Change - abrupt level change",
    "oscillating": "Oscillation - periodic fluctuation",
    "dampening": "Dampening Oscillation - decreasing amplitude waves",
    "overshoot": "Overshoot - exceeds target then settles",
    # With direction suffixes
    "linear_growth": "Linear Growth - steady positive increase",
    "linear_decline": "Linear Decline - steady negative decrease",
    "linear_flat": "Linear Flat - near-constant with slight linear trend",
    "accelerating_growth": "Accelerating Growth - increasing rate of growth (quadratic)",
    "accelerating_decline": "Accelerating Decline - increasing rate of decline (quadratic)",
    "accelerating_flat": "Accelerating Flat - quadratic curve with minimal net change",
    "inflecting_growth": "Inflecting Growth - cubic curve trending upward",
    "inflecting_decline": "Inflecting Decline - cubic curve trending downward",
    "inflecting_flat": "Inflecting Flat - cubic curve with minimal net change",
    "exponential_growth": "Exponential Growth - rapid accelerating increase",
    "exponential_decline": "Exponential Decline/Decay - rapid decelerating decrease",
    "exponential_flat": "Exponential Flat - exponential curve with minimal net change",
    "logarithmic_growth": "Logarithmic Growth - fast early growth that decelerates",
    "logarithmic_decline": "Logarithmic Decline - inverted logarithmic decrease",
    "logarithmic_flat": "Logarithmic Flat - logarithmic curve with minimal net change",
    "s_curve_growth": "S-Curve Growth - sigmoid/logistic growth to plateau",
    "s_curve_decline": "S-Curve Decline - sigmoid/logistic decay to floor",
    "s_curve_flat": "S-Curve Flat - sigmoid curve with minimal net change",
    "peak": "Peak/Bump Up - rises to maximum then falls",
    "dip": "Dip/Bump Down - falls to minimum then rises",
    "step_up": "Step Up - abrupt increase to new level",
    "step_down": "Step Down - abrupt decrease to new level",
    "oscillating_trending_up": "Oscillation with Growth - periodic fluctuation with upward trend",
    "oscillating_trending_down": "Oscillation with Decay - periodic fluctuation with downward trend",
    "dampening_trending_up": "Dampening with Growth - dampening oscillation with upward trend",
    "dampening_trending_down": "Dampening with Decay - dampening oscillation with downward trend",
    "overshoot_up": "Overshoot Up - rises past target then settles back",
    "overshoot_down": "Overshoot Down - falls past target then settles back",
}


def classify(data: np.ndarray, top_n: int = 5) -> ClassificationResult:
    """
    Classify time series data into a behavioral pattern.

    Args:
        data: Time series data as numpy array
        top_n: Number of top matches to return

    Returns:
        ClassificationResult with classification details
    """
    if data is None or len(data) == 0:
        raise ValueError("Data cannot be empty")
    
    if len(data) < 5:
        raise ValueError("Data must have at least 5 points for classification")
    
    # Run classification
    result = classify_timeseries_shape_and_scale(list(data))
    
    shape = result["shape"]
    scale = result["scale"]
    
    # Get top N matches from probabilities
    probs = shape["probabilities"]
    sorted_probs = sorted(probs.items(), key=lambda x: x[1], reverse=True)[:top_n]
    
    top_matches = []
    for label, prob in sorted_probs:
        desc = PATTERN_DESCRIPTIONS.get(label, PATTERN_DESCRIPTIONS.get(label.split("_")[0], "Unknown pattern"))
        top_matches.append({
            "label": label,
            "description": desc,
            "probability": prob
        })
    
    best_label = shape["best_label"]
    
    return ClassificationResult(
        best_label=best_label,
        base_shape=shape["base_shape"],
        direction=shape["direction"],
        probabilities=probs,
        shape_rmse=shape["shape_rmse"],
        possibly_complex=shape["possibly_complex_or_unmodeled"],
        scale_metadata=scale,
        top_matches=top_matches
    )


def load_csv_data(filepath: str, column: Optional[str] = None, skip_header: bool = True) -> np.ndarray:
    """
    Load time series data from a CSV file.

    Args:
        filepath: Path to the CSV file
        column: Column name or index to use (default: first numeric column)
        skip_header: Whether the file has a header row

    Returns:
        Numpy array of the time series data
    """
    data = []

    with open(filepath, 'r', newline='') as f:
        reader = csv.reader(f)

        if skip_header:
            header = next(reader, None)
            if column and header:
                try:
                    col_idx = int(column)
                except ValueError:
                    col_idx = header.index(column) if column in header else 0
            else:
                col_idx = 0
        else:
            col_idx = int(column) if column else 0

        for row in reader:
            if row and len(row) > col_idx:
                try:
                    data.append(float(row[col_idx]))
                except ValueError:
                    continue

    return np.array(data)


def load_json_data(filepath: str, key: Optional[str] = None) -> np.ndarray:
    """
    Load time series data from a JSON file.

    Args:
        filepath: Path to the JSON file
        key: Key to access data if JSON is an object (default: use root if array)

    Returns:
        Numpy array of the time series data
    """
    with open(filepath, 'r') as f:
        data = json.load(f)

    if key:
        data = data[key]

    if isinstance(data, dict):
        # Try common keys
        for k in ['data', 'values', 'timeseries', 'series', 'y']:
            if k in data:
                data = data[k]
                break

    return np.array(data, dtype=float)


def format_output(result: ClassificationResult, format_type: str = "text") -> str:
    """Format classification result for output."""
    if format_type == "json":
        return json.dumps(asdict(result), indent=2)
    elif format_type == "csv":
        return f"{result.best_label},{result.base_shape},{result.direction},{result.shape_rmse},{result.possibly_complex}"
    else:  # text
        best_desc = PATTERN_DESCRIPTIONS.get(
            result.best_label,
            PATTERN_DESCRIPTIONS.get(result.base_shape, "Unknown pattern")
        )
        lines = [
            "=" * 70,
            "TIME SERIES BEHAVIOR CLASSIFICATION RESULT",
            "=" * 70,
            f"Best Label:        {result.best_label}",
            f"Description:       {best_desc}",
            f"Base Shape:        {result.base_shape}",
            f"Direction:         {result.direction}",
            f"Shape RMSE:        {result.shape_rmse:.4f}",
            f"Possibly Complex:  {'Yes' if result.possibly_complex else 'No'}",
            "",
            "Scale Metadata:",
            f"  Start Value:     {result.scale_metadata['start_value']:.4f}",
            f"  End Value:       {result.scale_metadata['end_value']:.4f}",
            f"  Delta:           {result.scale_metadata['delta']:.4f} ({result.scale_metadata['delta_percent']:.1f}%)",
            f"  Range:           {result.scale_metadata['range']:.4f}",
            f"  Mean:            {result.scale_metadata['mean']:.4f}",
            f"  Std Dev:         {result.scale_metadata['std']:.4f}",
            "",
            "Top Matches:",
        ]
        for i, match in enumerate(result.top_matches, 1):
            lines.append(f"  {i}. {match['label']} ({match['probability']:.3f}) - {match['description']}")
        lines.append("=" * 70)
        return "\n".join(lines)


def list_patterns():
    """Print all available behavior patterns."""
    print("\nAvailable Behavior Pattern Labels:")
    print("=" * 70)
    print(f"{'Label':<35} {'Description':<35}")
    print("-" * 70)
    for label, desc in sorted(PATTERN_DESCRIPTIONS.items()):
        # Truncate long descriptions
        desc_short = desc[:32] + "..." if len(desc) > 35 else desc
        print(f"{label:<35} {desc_short:<35}")
    print("=" * 70)


def main():
    """Main entry point for command-line usage."""
    parser = argparse.ArgumentParser(
        description="Classify time series behavior patterns for System Dynamics model output",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s data.csv
  %(prog)s data.csv --column value --format json
  %(prog)s data.json --output results.json
  %(prog)s --list-patterns

Pattern Labels include:
  stable, inactive      - No change / near-zero
  linear_growth/decline - Linear trends
  exponential_growth    - Rapid accelerating increase
  logarithmic_growth    - Fast early growth, decelerating
  s_curve_growth        - Sigmoid/logistic growth
  peak, dip             - Bump up or down
  oscillating           - Periodic fluctuation
  dampening             - Decreasing amplitude oscillation
  overshoot_up/down     - Overshoot and settle
  (use --list-patterns for full list)
        """
    )

    parser.add_argument("input", nargs="?", help="Input file (CSV or JSON)")
    parser.add_argument("-c", "--column", help="Column name or index for CSV files")
    parser.add_argument("-o", "--output", help="Output file path")
    parser.add_argument("-f", "--format", choices=["text", "json", "csv"],
                        default="text", help="Output format (default: text)")
    parser.add_argument("--top", type=int, default=5, help="Number of top matches to show")
    parser.add_argument("--list-patterns", action="store_true",
                        help="List all available pattern labels")
    parser.add_argument("--version", action="version", version="%(prog)s 1.0.0")

    args = parser.parse_args()

    # List patterns and exit
    if args.list_patterns:
        list_patterns()
        return 0

    # Require input file for classification
    if not args.input:
        parser.error("Input file is required (use --list-patterns to see available patterns)")

    # Load data
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        return 1

    try:
        if input_path.suffix.lower() == ".json":
            data = load_json_data(str(input_path))
        else:
            data = load_csv_data(str(input_path), args.column)
    except Exception as e:
        print(f"Error loading data: {e}", file=sys.stderr)
        return 1

    if len(data) == 0:
        print("Error: No valid data found in input file", file=sys.stderr)
        return 1

    # Classify
    try:
        result = classify(data, args.top)
        output = format_output(result, args.format)
    except ValueError as e:
        print(f"Error classifying data: {e}", file=sys.stderr)
        return 1

    # Output results
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"Results written to: {args.output}")
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
