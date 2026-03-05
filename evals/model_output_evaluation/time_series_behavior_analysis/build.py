"""
Build script for creating classify_behavior.exe

This script uses PyInstaller to create a standalone executable for the
time series behavior classification tool.

Usage:
    python build.py
    python build.py --onefile    # Create single executable (default)
    python build.py --onedir     # Create directory with dependencies
    python build.py --clean      # Clean build artifacts first
"""

import os
import sys
import shutil
import subprocess
import argparse
from pathlib import Path


def get_project_paths():
    """Get relevant project paths."""
    script_dir = Path(__file__).parent.resolve()
    return {
        'root': script_dir,
        'main_script': script_dir / 'classify_behavior.py',
        'init_module': script_dir / '__init__.py',
        'dist': script_dir / 'dist',
        'build': script_dir / 'build',
        'dist_examples': script_dir / 'dist_examples',
    }


def clean_build(paths):
    """Clean previous build artifacts."""
    print("Cleaning previous build artifacts...")

    for folder in ['dist', 'build']:
        folder_path = paths[folder]
        if folder_path.exists():
            shutil.rmtree(folder_path)
            print(f"  Removed: {folder_path}")

    # Remove .spec file if exists
    spec_file = paths['root'] / 'classify_behavior.spec'
    if spec_file.exists():
        spec_file.unlink()
        print(f"  Removed: {spec_file}")

    print("Clean complete.\n")


def check_requirements():
    """Check that required packages are installed."""
    print("Checking requirements...")

    try:
        import PyInstaller
        print(f"  PyInstaller version: {PyInstaller.__version__}")
    except ImportError:
        print("  PyInstaller not found. Installing...")
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pyinstaller'])
        print("  PyInstaller installed successfully.")

    # Check other requirements
    required = ['numpy']
    for pkg in required:
        try:
            __import__(pkg)
            print(f"  {pkg}: OK")
        except ImportError:
            print(f"  {pkg}: Not found - installing...")
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', pkg])

    print("Requirements check complete.\n")


def build_executable(paths, onefile=True):
    """Build the executable using PyInstaller."""
    print("Building executable...")

    # Prepare PyInstaller arguments
    args = [
        sys.executable,
        '-m', 'PyInstaller',
        '--name', 'classify_behavior',
        '--noconfirm',  # Replace output without asking
    ]

    if onefile:
        args.append('--onefile')
    else:
        args.append('--onedir')

    # Add console mode (for CLI tool)
    args.append('--console')

    # Add the __init__.py module as data (needed at runtime)
    init_module = paths['init_module']
    if init_module.exists():
        args.extend([
            '--add-data', f'{init_module}{os.pathsep}.'
        ])
        print(f"  Including module: {init_module}")

    # Add hidden imports
    args.extend([
        '--hidden-import', 'numpy',
    ])

    # Add paths for module discovery
    args.extend([
        '--paths', str(paths['root']),
    ])

    # Set output directory
    args.extend([
        '--distpath', str(paths['dist']),
        '--workpath', str(paths['build']),
        '--specpath', str(paths['root']),
    ])

    # Add the main script
    args.append(str(paths['main_script']))

    print(f"  Command: {' '.join(args)}")
    print("\n  Building... (this may take a minute)\n")

    # Run PyInstaller
    result = subprocess.run(args, cwd=str(paths['root']))

    if result.returncode == 0:
        exe_name = 'classify_behavior.exe' if sys.platform == 'win32' else 'classify_behavior'
        exe_path = paths['dist'] / exe_name
        print(f"\n✓ Build successful!")
        print(f"  Executable: {exe_path}")

        if exe_path.exists():
            size_mb = exe_path.stat().st_size / (1024 * 1024)
            print(f"  Size: {size_mb:.1f} MB")
            
            # Copy to dist_examples if it exists
            dist_examples = paths['dist_examples']
            if dist_examples.exists():
                dest = dist_examples / exe_name
                shutil.copy2(exe_path, dest)
                print(f"  Copied to: {dest}")

        return True
    else:
        print(f"\n✗ Build failed with return code: {result.returncode}")
        return False


def create_spec_file(paths, onefile=True):
    """Create a custom .spec file for more control over the build."""
    spec_content = f'''# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    [r'{paths["main_script"]}'],
    pathex=[r'{paths["root"]}'],
    binaries=[],
    datas=[
        (r'{paths["init_module"]}', '.'),
    ],
    hiddenimports=['numpy'],
    hookspath=[],
    hooksconfig={{}},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

'''

    if onefile:
        spec_content += '''
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='classify_behavior',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
'''
    else:
        spec_content += '''
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='classify_behavior',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='classify_behavior',
)
'''

    spec_file = paths['root'] / 'classify_behavior.spec'
    with open(spec_file, 'w') as f:
        f.write(spec_content)

    print(f"Created spec file: {spec_file}")
    return spec_file


def main():
    parser = argparse.ArgumentParser(description="Build classify_behavior executable")
    parser.add_argument('--onefile', action='store_true', default=True,
                        help="Create a single executable file (default)")
    parser.add_argument('--onedir', action='store_true',
                        help="Create a directory with executable and dependencies")
    parser.add_argument('--clean', action='store_true',
                        help="Clean build artifacts before building")
    parser.add_argument('--clean-only', action='store_true',
                        help="Only clean, don't build")
    parser.add_argument('--use-spec', action='store_true',
                        help="Generate and use a custom .spec file")

    args = parser.parse_args()

    # Determine onefile mode
    onefile = not args.onedir

    print("=" * 60)
    print("Time Series Behavior Classifier - Build Script")
    print("=" * 60)
    print()

    paths = get_project_paths()

    # Verify main script exists
    if not paths['main_script'].exists():
        print(f"Error: Main script not found: {paths['main_script']}")
        return 1

    # Clean if requested
    if args.clean or args.clean_only:
        clean_build(paths)
        if args.clean_only:
            return 0

    # Check requirements
    check_requirements()

    # Build
    if args.use_spec:
        spec_file = create_spec_file(paths, onefile)
        # Build using spec file
        result = subprocess.run([
            sys.executable, '-m', 'PyInstaller',
            '--noconfirm',
            str(spec_file)
        ], cwd=str(paths['root']))
        success = result.returncode == 0
    else:
        success = build_executable(paths, onefile)

    if success:
        print("\n" + "=" * 60)
        print("Build Complete!")
        print("=" * 60)
        print("\nTo test the executable:")
        print(f"  cd {paths['dist']}")
        print("  .\\classify_behavior.exe --help")
        print("  .\\classify_behavior.exe --list-patterns")
        print("  .\\classify_behavior.exe ..\\sample_data\\exponential_growth.csv --format json")
        return 0
    else:
        return 1


if __name__ == "__main__":
    sys.exit(main())
