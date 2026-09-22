# saves the clipboard image to a PNG file; prints the path on stdout
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File paste-image.ps1 <outFile>
param([Parameter(Mandatory = $true)][string]$OutFile)

Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if (-not $img) {
  Write-Output "NO_IMAGE"
  exit 1
}
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$img.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($img.Width)x$($img.Height) $OutFile"
exit 0