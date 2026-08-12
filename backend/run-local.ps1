Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $scriptDir 'venv\Scripts\python.exe'

if (-not (Test-Path $pythonExe)) {
  throw "Missing backend venv Python. Run: python -m venv venv ; .\\venv\\Scripts\\activate ; pip install -r requirements.txt"
}

& $pythonExe -m uvicorn app.main:app --app-dir $scriptDir --host 127.0.0.1 --port 8001 --reload