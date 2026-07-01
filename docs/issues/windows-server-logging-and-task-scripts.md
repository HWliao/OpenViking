# Windows Server Logging And Task Scripts

## Problem

The packaged Windows startup flow wrote large amounts of server output into `openviking-server-wrapper.log`. The wrapper log contained repeated Python logging rollover failures such as `PermissionError: [WinError 32]` while renaming `openviking.log` to a dated archive. The scheduled task also used a VBS launcher directly and was not structured for a packaged install directory.

## Root Cause

- `start-openviking-server.vbs` redirected `stdout` and `stderr` into `openviking-server-wrapper.log`.
- `openviking.server.bootstrap` used direct `print(...)` calls for startup status, Ollama checks, and bot messages.
- `openviking.telemetry.tracer` used Loguru's default stderr sink.
- Third-party libraries using the root logger could fall back to stderr instead of the OpenViking server log.
- Python `TimedRotatingFileHandler` uses `os.rename` during rollover. On Windows this fails with `WinError 32` if another process or handler still holds the active log file.

## Changes

- Added packaged Windows scripts under `scripts/`.
- `scripts/manage-openviking-server.ps1` now defaults the install directory to the PS1 directory, resolves the VBS launcher from the same directory, and creates a scheduled task with a default logon delay of 10 seconds.
- `scripts/start-openviking-server.vbs` archives old wrapper and server log files before every launch so each startup begins with fresh logs.
- Server startup messages now use the unified OpenViking logger instead of `print(...)` after config loading succeeds.
- Tracer logging now uses the unified logger instead of Loguru's default stderr sink.
- Added `configure_server_logging()` to route OpenViking, Uvicorn, and root logger output to the configured server log.
- Added a Windows-safe timed rotating handler that defers rollover on `WinError 32` instead of repeatedly writing `--- Logging error ---` to stderr.
- `TraceContextFilter` now injects operation fields including `telemetry_id` and `status`.
- Updated VLM base logger usage to avoid `logging.getLogger(__name__)` in runtime modules covered by the regression test.

## Local Test Environment Notes

- The first pytest attempt failed because the environment lacked `pytest_asyncio`.
- `.venv` also lacked `pytest` initially.
- `uv sync --frozen --extra test` attempted an editable build and failed without native build tools.
- A prebuilt `ov.exe` can satisfy the Rust CLI artifact with `OV_PREBUILT_BIN_DIR` and `OV_SKIP_OV_BUILD=1`, but RAGFS and CMake native builds still require Cargo/CMake/MinGW tooling.
- For focused Python tests, runtime and test dependencies were installed directly into `.venv`, and `PYTHONPATH` included `tests/api_test` plus the repository root.

## Verification

Focused pytest command passed:

```powershell
$env:PYTHONPATH = "D:\develop\source-workspace\OpenViking\tests\api_test;D:\develop\source-workspace\OpenViking"
& ".venv\Scripts\python.exe" -m pytest "tests/test_config_loader.py::test_early_logger_initialization_is_reconfigured_to_file_output" "tests/api_test/tools/tests/test_logger.py" "tests/api_test/tools/tests/test_logger_usage_regression.py" -q --no-cov --tb=short
```

Result:

```text
6 passed, 4 warnings
```

Additional checks performed:

- Python compile check passed for modified Python files.
- PS1 `status` action ran successfully.
- VBS syntax/execution path was validated with a non-existent install directory and exited as expected.
- Simulated Windows log lock verified that rollover no longer writes logging errors to stderr and regular log writes continue.
