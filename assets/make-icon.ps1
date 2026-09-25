Add-Type -AssemblyName System.Drawing

$size = 512
$text = "aura"
$out = "C:\Users\dunice\Documents\Soft\aura\assets\icon.png"

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)

# auto-fit: start large, shrink until the word fits within 78% of the canvas
$fontSize = 240
while ($fontSize -gt 40) {
	$font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
	$w = $g.MeasureString($text, $font).Width
	if ($w -le $size * 0.78) { break }
	$fontSize = $fontSize - 8
}

# lowercase-only text sits low in the line box (which reserves ascent room) —
# nudge up so the glyphs look optically centered
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$lift = $fontSize * 0.10
$rect = New-Object System.Drawing.RectangleF(0, -$lift, $size, $size)
$g.DrawString($text, $font, [System.Drawing.Brushes]::Black, $rect, $fmt)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved $out (font ${fontSize}px)"
