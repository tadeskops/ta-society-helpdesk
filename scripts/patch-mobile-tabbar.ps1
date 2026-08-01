$ErrorActionPreference = 'Stop'
$docs = 'C:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs'
# `committee-dashboard.html` is a <meta refresh> redirect stub — no theme.css /
# ui.js / footer include, so the regexes below never match and the file is
# left alone. `index.html` (the landing) IS included so the same tab-bar
# lands there too.
$pages = @(
  'index.html','committee-dashboard.html','daily-confirm.html','daily-report.html',
  'directory.html','manage.html','manager-dashboard.html','public-board.html',
  'reservations.html','settings.html','treasury.html','vehicles.html'
)

# SAFE utf-8 read/write (BOM-less). Never use Get-Content -Raw + Set-Content
# -Encoding UTF8 on Windows PowerShell 5.1 — CP1252 round-trip corrupts every
# em-dash, curly quote, non-ASCII char in the file. See repo memory.
$enc = New-Object System.Text.UTF8Encoding($false)

# Cache-bust versions kept in sync with the memory/deployed asset versions.
$cssVer = 14
$jsVer  = 8

foreach ($p in $pages) {
  $path = Join-Path $docs $p
  if (-not (Test-Path $path)) { Write-Warning "MISSING $p"; continue }
  $c = [System.IO.File]::ReadAllText($path, $enc)
  $orig = $c

  # 1. Insert mobile-landing.css after theme.css (or normalise version).
  #    The theme.css version bumps over time (currently ?v=87 on most pages,
  #    ?v=88 on settings/treasury), so match any digit run — the anchor is
  #    the theme.css link tag, not a specific version.
  if ($c -notmatch 'mobile-landing\.css') {
    $insert = "`r`n  <!-- Mobile-only tab-bar overlay + WhatsApp-style bottom sheet. Loaded on every page so the same bottom nav appears in mobile view; hidden above 640px by the CSS media query. -->`r`n  <link rel=""stylesheet"" href=""./assets/css/mobile-landing.css?v=$cssVer"" />"
    $c = $c -replace '(<link rel="stylesheet" href="\./assets/css/theme\.css\?v=\d+" />)', ('$1' + $insert)
  } else {
    $c = $c -replace 'mobile-landing\.css\?v=\d+', "mobile-landing.css?v=$cssVer"
  }

  # 2a. Insert mobile-actions-sheet partial include before footer include.
  if ($c -notmatch 'data-include="mobile-actions-sheet"') {
    $c = $c -replace '(<div data-include="footer"></div>)', ('<div data-include="mobile-actions-sheet"></div>' + "`r`n  " + '$1')
  }

  # 2b. Insert mobile-tabbar partial include before the actions-sheet (so the
  #     tab-bar renders above the hidden sheet in DOM order).
  if ($c -notmatch 'data-include="mobile-tabbar"') {
    $c = $c -replace '(<div data-include="mobile-actions-sheet"></div>)', ('<div data-include="mobile-tabbar"></div>' + "`r`n  " + '$1')
  }

  # 3. Insert mobile-landing.js after ui.js (or normalise version).
  if ($c -notmatch 'assets/js/mobile-landing\.js') {
    $insert = "`r`n  <script src=""./assets/js/mobile-landing.js?v=$jsVer""></script>"
    $c = $c -replace '(<script src="\./assets/js/ui\.js\?v=\d+"></script>)', ('$1' + $insert)
  } else {
    $c = $c -replace 'mobile-landing\.js\?v=\d+', "mobile-landing.js?v=$jsVer"
  }

  if ($c -ne $orig) {
    [System.IO.File]::WriteAllText($path, $c, $enc)
    Write-Host "PATCHED $p" -ForegroundColor Green
  } else {
    Write-Host "no-change $p" -ForegroundColor Yellow
  }
}
