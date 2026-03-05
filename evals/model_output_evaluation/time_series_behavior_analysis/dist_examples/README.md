# Behavioral Classifier - Standalone Distribution

This folder contains the standalone executable for classifying time series data into
behavioral patterns, along with example usage.

## Contents

- **classify_behavior.exe** - Standalone executable (no Python installation required)
- **README.md** - This file

## Quick Start

### List Available Patterns

```bash
classify_behavior.exe --list-patterns
```

### Classify from CSV File

```bash
# Classify time series data from a CSV file
classify_behavior.exe data.csv --format json
```

### Example with Sample Data

```bash
# Use sample data from parent directory
classify_behavior.exe ..\sample_data\exponential_growth.csv --format json
classify_behavior.exe ..\sample_data\s_curve_growth.csv
classify_behavior.exe ..\sample_data\oscillation.csv --format text
```

## Input Formats

### CSV File
```csv
value
1.0
2.0
4.0
8.0
16.0
```

Or with named columns:
```csv
time,value
0,1.0
1,2.0
2,4.0
3,8.0
```

### JSON Array (file)
```json
[1.0, 2.0, 4.0, 8.0, 16.0]
```

## Output Formats

Use `--format` to specify output format:
- `text` - Human-readable text (default)
- `json` - Machine-readable JSON (recommended for programmatic use)
- `csv` - CSV format

## Common Options

| Option | Description |
|--------|-------------|
| `--format {json,text,csv}` | Output format |
| `--top N` | Show top N pattern matches (default: 5) |
| `--column NAME` | Column to use from CSV (default: first column) |
| `--output FILE` | Save results to file |
| `--list-patterns` | List all available behavior patterns |
| `--version` | Show version |
| `--help` | Show help |

## Example JSON Output

```json
{
  "best_label": "exponential_growth",
  "base_shape": "exponential",
  "direction": "increasing",
  "probabilities": {
    "exponential": 0.89,
    "s_curve": 0.06,
    "linear": 0.03,
    ...
  },
  "shape_rmse": 0.042,
  "possibly_complex": false,
  "scale_metadata": {
    "start_value": 5.24,
    "end_value": 32133.48,
    "delta": 32128.24,
    "mean": 5842.15,
    ...
  },
  "top_matches": [
    {"label": "exponential", "description": "Exponential Growth", "probability": 0.89},
    ...
  ]
}
```

## Available Pattern Labels

Key patterns include:
- `stable`, `inactive` - No change / near-zero values
- `linear_growth`, `linear_decline` - Linear trends
- `exponential_growth`, `exponential_decline` - Exponential trends
- `logarithmic_growth`, `logarithmic_decline` - Logarithmic trends
- `s_curve_growth`, `s_curve_decline` - Sigmoid/logistic curves
- `peak`, `dip` - Bump up or down
- `step_up`, `step_down` - Abrupt level changes
- `oscillating` - Periodic fluctuation
- `dampening` - Decreasing amplitude oscillation
- `overshoot_up`, `overshoot_down` - Overshoot and settle

Use `--list-patterns` for the complete list with descriptions.

## Requirements

- **Windows** - The executable is built for Windows
- **No Python required** - Everything is bundled in the executable

## Building the Executable

To rebuild the executable from source:

```bash
cd time_series_behavior_analysis
python build.py
```

The executable will be created in the `dist/` folder and automatically copied here.

## For Full Documentation

See the main [README.md](../README.md) in the `time_series_behavior_analysis` folder.
