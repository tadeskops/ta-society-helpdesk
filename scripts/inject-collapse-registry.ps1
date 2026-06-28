$ErrorActionPreference = 'Stop'
Set-Location c:\CR7\TAMC\IRP_Repo\ta-society-helpdesk\docs
$pages = 'index.html','daily-confirm.html','daily-report.html','directory.html','manage.html','manager-dashboard.html','public-board.html'
$enc = New-Object System.Text.UTF8Encoding $false
$inject = "`r`n  <script src=`"./assets/js/collapse-registry.js?v=1`"></script>"
foreach ($p in $pages) {
  $full = Join-Path (Get-Location) $p
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
  $orig = $txt
  $txt = $txt -replace 'ui\.js\?v=34','ui.js?v=35'
  $txt = $txt -replace '(?m)^(\s*)<script src="\./assets/js/flags\.js\?v=12"></script>$','$1<script src="./assets/js/flags.js?v=13"></script>'
  if ($txt -notmatch 'collapse-registry\.js') {
    $replacement = '<script src="./assets/js/flags.js?v=13"></script>' + $inject
    $txt = $txt.Replace('<script src="./assets/js/flags.js?v=13"></script>', $replacement)
  }
  if ($txt -ne $orig) {
    [System.IO.File]::WriteAllText($full, $txt, $enc)
    Write-Output "Updated $p"
  } else {
    Write-Output "No change $p"
  }
}
