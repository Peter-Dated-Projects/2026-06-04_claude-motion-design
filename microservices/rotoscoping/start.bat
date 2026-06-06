@echo off
REM Start the rotoscoping microservice. Requires uv on PATH and a CUDA 12.8 box.
REM First run downloads SAM2 weights (~900MB) into models\ and, if ffmpeg is not
REM on PATH, a static ffmpeg build into bin\.
uv run main.py
