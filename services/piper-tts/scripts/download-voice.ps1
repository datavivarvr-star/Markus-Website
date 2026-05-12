#!/usr/bin/env pwsh
param(
  [string]$Voice = "en_US-ryan-medium",
  [string]$DestDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $DestDir) {
  $DestDir = Join-Path (Split-Path -Parent $PSScriptRoot) "voices"
}

switch ($Voice) {
  "en_US-ryan-medium"   { $RelPath = "en/en_US/ryan/medium" }
  "en_US-amy-medium"    { $RelPath = "en/en_US/amy/medium" }
  "en_US-lessac-medium" { $RelPath = "en/en_US/lessac/medium" }
  "en_GB-alan-medium"   { $RelPath = "en/en_GB/alan/medium" }
  default {
    Write-Error "Unknown voice: $Voice. Add it to download-voice.ps1 or download manually from https://huggingface.co/rhasspy/piper-voices"
  }
}

$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$RelPath"

if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir | Out-Null }
Write-Host "Downloading $Voice to $DestDir ..."

Invoke-WebRequest -Uri "$base/$Voice.onnx"      -OutFile (Join-Path $DestDir "$Voice.onnx")
Invoke-WebRequest -Uri "$base/$Voice.onnx.json" -OutFile (Join-Path $DestDir "$Voice.onnx.json")

Write-Host "Done."
Get-ChildItem (Join-Path $DestDir "$Voice.onnx"), (Join-Path $DestDir "$Voice.onnx.json") | Format-List Name, Length
