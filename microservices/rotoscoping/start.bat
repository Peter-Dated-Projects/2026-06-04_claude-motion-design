@echo off
REM Start the rotoscoping microservice. Requires uv on PATH and a CUDA 12.8 box.
REM First run downloads SAM2 weights (~900MB) into models\ and, if ffmpeg is not
REM on PATH, a static ffmpeg build into bin\.
REM extra-build-dependencies (preview in uv 0.9.x) injects setuptools/wheel into
REM SAM2's build env -- see pyproject.toml [tool.uv.extra-build-dependencies].
set UV_PREVIEW_FEATURES=extra-build-dependencies
uv run main.py
