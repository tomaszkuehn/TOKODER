# persistent clipboard watcher: reads output paths from stdin (one per line),
# saves the clipboard image as PNG, answers "WxH <path>" or "NO_IMAGE" on stdout
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $out = $line.Trim()
  if (-not $out) { continue }
  try {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) {
      $dir = Split-Path -Parent $out
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      [Console]::Out.WriteLine("$($img.Width)x$($img.Height) $out")
    } else {
      [Console]::Out.WriteLine("NO_IMAGE")
    }
  } catch {
    [Console]::Out.WriteLine("NO_IMAGE")
  }
}